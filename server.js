// Comment Card — consumer-first feedback app with public suggestion feeds.
// Stack: Node.js + Express + SQLite (better-sqlite3). Email via nodemailer
// (SMTP env vars only). Business lookup via Google Places API (New),
// OpenStreetMap Nominatim, and the business's own website (for published emails).
// Run:  npm install && npm start   (listens on PORT, default 3000)

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Set COOKIE_SECURE=1 when serving over HTTPS (Render / Fly do TLS for you).
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const BCRYPT_ROUNDS = 12;

// Public base URL for claim links / QR codes. Prefer an explicit PUBLIC_URL,
// then Render's own external URL, then the request's own origin.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// Email (optional). If SMTP_HOST is not set, emails are logged to the console
// instead of sent — the flow still works, and the claim link is shown on the
// business's public page. See README.md for setup (Gmail app password,
// Resend, or SendGrid SMTP).
const EMAIL_FROM = process.env.EMAIL_FROM || 'Comment Card <no-reply@commentcard.app>';
let mailer = null;
if (process.env.SMTP_HOST) {
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
}

// Google Places API (New) — optional. Key stays server-side only; the
// browser never sees it. Without a key the lookup falls back to Nominatim.
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

// Comments only come from within this many miles of the business, to keep
// out-of-area spam out. Override with COMMENT_MAX_MILES.
const COMMENT_MAX_MILES = parseFloat(process.env.COMMENT_MAX_MILES || '20') || 20;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(path.join(DATA_DIR, 'comment-card.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    place_id      TEXT,
    lat           REAL,
    lng           REAL,
    address       TEXT,
    claimed       INTEGER NOT NULL DEFAULT 0,
    claim_token   TEXT,
    welcome_note  TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    area            TEXT NOT NULL,
    text            TEXT NOT NULL,
    better_text     TEXT NOT NULL DEFAULT '',
    visit_frequency TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    contact         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'new',
    hidden          INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS replies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_business_created
    ON comments (business_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_business_status
    ON comments (business_id, status);
  CREATE INDEX IF NOT EXISTS idx_replies_comment
    ON replies (comment_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_businesses_claim_token
    ON businesses (claim_token);
  CREATE INDEX IF NOT EXISTS idx_businesses_place_id
    ON businesses (place_id);
`);

// Migrate databases created by the earlier signup-first version:
// - businesses gains claimed / claim_token / place_id columns
// - password_hash becomes nullable (unclaimed businesses have no password yet)
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(businesses)').all();
  if (!cols.length) return; // fresh database — CREATE TABLE above already ran
  const names = new Set(cols.map((c) => c.name));
  const pw = cols.find((c) => c.name === 'password_hash');
  if (pw && pw.notnull === 1) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE businesses_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        slug          TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        place_id      TEXT,
        lat           REAL,
        lng           REAL,
        address       TEXT,
        claimed       INTEGER NOT NULL DEFAULT 0,
        claim_token   TEXT,
        welcome_note  TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO businesses_new (id, slug, name, email, password_hash, welcome_note, created_at)
        SELECT id, slug, name, email, password_hash, welcome_note, created_at FROM businesses;
      DROP TABLE businesses;
      ALTER TABLE businesses_new RENAME TO businesses;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    console.log('Migrated businesses table (nullable password, claimed/claim_token/place_id).');
    return;
  }
  if (!names.has('claimed')) {
    db.exec('ALTER TABLE businesses ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('claim_token')) {
    db.exec('ALTER TABLE businesses ADD COLUMN claim_token TEXT');
  }
  if (!names.has('place_id')) {
    db.exec('ALTER TABLE businesses ADD COLUMN place_id TEXT');
  }
  if (!names.has('lat')) {
    db.exec('ALTER TABLE businesses ADD COLUMN lat REAL');
  }
  if (!names.has('lng')) {
    db.exec('ALTER TABLE businesses ADD COLUMN lng REAL');
  }
  if (!names.has('address')) {
    db.exec('ALTER TABLE businesses ADD COLUMN address TEXT');
  }
})();

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const KINDS = ['bugged', 'change', 'idea'];
const AREAS = ['service', 'wait-time', 'price', 'cleanliness', 'food-quality', 'staff', 'other'];
const STATUSES = ['new', 'noted', 'acted_on', 'archived'];
const VISIT_FREQUENCIES = ['first-time', 'sometimes', 'regular', ''];
const FEED_STATUSES = ['new', 'noted', 'acted_on']; // archived never shows publicly
const KIND_LABELS = { bugged: 'Something bugged me', change: "Something I'd change", idea: 'An idea' };
const AREA_LABELS = {
  service: 'Service',
  'wait-time': 'Wait time',
  price: 'Price',
  cleanliness: 'Cleanliness',
  'food-quality': 'Food / product quality',
  staff: 'Staff',
  other: 'Something else',
};

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'business';
  return base;
}

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  const exists = db.prepare('SELECT 1 FROM businesses WHERE slug = ?');
  while (exists.get(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

function newClaimToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function publicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function claimUrlFor(req, business) {
  return `${publicOrigin(req)}/claim/${business.claim_token}`;
}

// QR codes are generated on demand and cached per claim URL.
const qrCache = new Map();
async function claimQrDataUrl(claimUrl) {
  if (qrCache.has(claimUrl)) return qrCache.get(claimUrl);
  const dataUrl = await QRCode.toDataURL(claimUrl, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  qrCache.set(claimUrl, dataUrl);
  return dataUrl;
}

// --- Email ---------------------------------------------------------------

async function sendBusinessEmail(to, subject, text) {
  if (!mailer) {
    console.log(
      '--- EMAIL (no SMTP configured — would send) ---\n'
      + `To: ${to}\nSubject: ${subject}\n\n${text}\n--- END EMAIL ---`,
    );
    return { sent: false, logged: true };
  }
  try {
    await mailer.sendMail({ from: EMAIL_FROM, to, subject, text });
    console.log(`Email sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    console.log(
      '--- EMAIL (send failed — content) ---\n'
      + `To: ${to}\nSubject: ${subject}\n\n${text}\n--- END EMAIL ---`,
    );
    return { sent: false, logged: true };
  }
}

function claimNotificationEmail(biz, comment, claimUrl, publicUrl) {
  const who = comment.name ? comment.name : 'Anonymous';
  return {
    subject: 'You have a comment on Comment Card',
    text:
      `Hi ${biz.name},\n\n`
      + `Someone left a comment for you on Comment Card:\n\n`
      + `"${comment.text}"\n`
      + `— ${who} · ${KIND_LABELS[comment.kind] || comment.kind} · ${AREA_LABELS[comment.area] || comment.area}\n`
      + (comment.better_text ? `\nWhat would have made it better: ${comment.better_text}\n` : '')
      + `\nComment Card is where customers tell a business what they'd change — honest and out in the open. Your comment is already live on your public page:\n${publicUrl}\n\n`
      + `Claim your page to reply to this comment and see the next ones as they come in:\n${claimUrl}\n\n`
      + `You can also scan the QR code shown on your public page.\n\n— Comment Card`,
  };
}

// --- Replies ---------------------------------------------------------------

function attachReplies(rows) {
  if (!rows.length) return rows.map((r) => ({ ...publicComment(r), replies: [] }));
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const reps = db.prepare(`
    SELECT r.*, b.name AS business_name FROM replies r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.comment_id IN (${placeholders})
    ORDER BY r.created_at ASC, r.id ASC
  `).all(...ids);
  const byComment = new Map();
  for (const rep of reps) {
    if (!byComment.has(rep.comment_id)) byComment.set(rep.comment_id, []);
    byComment.get(rep.comment_id).push({
      id: rep.id,
      text: rep.text,
      created_at: rep.created_at,
      business_name: rep.business_name,
    });
  }
  return rows.map((r) => ({ ...publicComment(r), replies: byComment.get(r.id) || [] }));
}

function publicComment(row) {
  // What the public feed exposes. Contact details are NEVER public.
  return {
    id: row.id,
    kind: row.kind,
    area: row.area,
    text: row.text,
    better_text: row.better_text,
    visit_frequency: row.visit_frequency,
    name: row.name || null,
    status: row.status,
    created_at: row.created_at,
  };
}

function dashboardComment(row) {
  return { ...publicComment(row), contact: row.contact, hidden: row.hidden === 1 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Tiny in-memory rate limiter: { key: { count, resetAt } }
const rateLimits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again.' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Business lookup cascade — Places, then Nominatim, then the business's
// own website (for published emails). Never scrapes Google or Yelp.
// ---------------------------------------------------------------------------

async function searchPlaces(query, loc) {
  const body = { textQuery: query, maxResultCount: loc ? 10 : 5 };
  if (loc) {
    // Bias toward places near the searcher (25 km circle) — nearest first.
    body.locationBias = {
      circle: { center: { latitude: loc.lat, longitude: loc.lng }, radius: 25000.0 },
    };
  }
  const res = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify(body),
  }, 6000);
  if (!res.ok) throw new Error(`Places search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.places || [])
    .map((p) => ({
      source: 'places',
      placeId: p.id,
      name: (p.displayName && p.displayName.text) || '',
      address: p.formattedAddress || '',
      lat: p.location ? p.location.latitude : null,
      lng: p.location ? p.location.longitude : null,
    }))
    .filter((r) => r.name);
}

// Nominatim (OpenStreetMap) — free, no key. Usage policy: identify the app
// in the User-Agent, max 1 request/second, short timeout.
let lastNominatimAt = 0;
async function searchNominatim(query, loc) {
  const doSearch = async (p) => {
    const wait = 1000 - (Date.now() - lastNominatimAt);
    if (wait > 0) await sleep(wait);
    lastNominatimAt = Date.now();
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams(p);
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Comment Card (business lookup; contact hello@commentcard.app)',
        'Accept-Language': 'en',
      },
    }, 5000);
    if (!res.ok) throw new Error(`Nominatim search failed: HTTP ${res.status}`);
    return res.json();
  };
  const base = {
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    extratags: '1',
    limit: '10',
  };
  const mapResults = (data) => data
    .map((r) => {
      const tags = r.extratags || {};
      return {
        source: 'nominatim',
        placeId: `osm:${r.osm_type}/${r.osm_id}`,
        name: r.name || String(r.display_name || '').split(',')[0].trim(),
        address: r.display_name || '',
        phone: tags.phone || tags['contact:phone'] || '',
        website: tags.website || tags['contact:website'] || '',
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      };
    })
    .filter((r) => r.name);
  if (!loc) return mapResults(await doSearch(base));
  // Progressive expansion: start with a tight box around the searcher so
  // nearby places aren't crowded out by bigger-city matches (Nominatim
  // ranks by importance, not distance), and widen only if few results
  // come back.
  let results = [];
  for (const deg of [0.12, 0.35]) {
    const params = {
      ...base,
      viewbox: `${loc.lng - deg},${loc.lat + deg},${loc.lng + deg},${loc.lat - deg}`,
      bounded: '1',
    };
    results = mergeResults(results, mapResults(await doSearch(params)));
    if (results.length >= 3) break;
  }
  if (results.length < 3) {
    // Generic words ("pizza") match poorly inside a box, so retry with the
    // searcher's area named in the query — that pulls local matches.
    const area = await reverseGeocodeArea(loc);
    if (area) {
      results = mergeResults(results, mapResults(await doSearch({ ...base, q: `${query}, ${area}` })));
    }
  }
  if (results.length < 3) {
    // Last resort: unbounded, so a far-away search still works.
    results = mergeResults(results, mapResults(await doSearch(base)));
  }
  return results;
}

// Turn coordinates into "County, State, Country" for locality-biased
// searches. Cached per rounded location so it costs one request at most.
const reverseCache = new Map();
async function reverseGeocodeArea(loc) {
  const key = `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}`;
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.area;
  try {
    const wait = 1000 - (Date.now() - lastNominatimAt);
    if (wait > 0) await sleep(wait);
    lastNominatimAt = Date.now();
    const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
      lat: String(loc.lat), lon: String(loc.lng), format: 'jsonv2',
    });
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Comment Card (business lookup; contact hello@commentcard.app)' },
    }, 5000);
    if (!res.ok) return null;
    const d = await res.json();
    const a = d.address || {};
    const parts = [a.county || a.city || a.town || a.village, a.state, a.country].filter(Boolean);
    const area = parts.length ? parts.join(', ') : null;
    if (area) reverseCache.set(key, { area, at: Date.now() });
    return area;
  } catch (e) {
    console.error('Reverse geocode failed:', e.message);
    return null;
  }
}

// Geocode a business name/address to { lat, lng } via Nominatim. Best
// effort — returns null when nothing is found.
async function geocodeBusiness(query) {
  if (!query) return null;
  try {
    const wait = 1000 - (Date.now() - lastNominatimAt);
    if (wait > 0) await sleep(wait);
    lastNominatimAt = Date.now();
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: query, format: 'jsonv2', limit: '1',
    });
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Comment Card (business lookup; contact hello@commentcard.app)' },
    }, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch (e) {
    console.error('Geocode failed:', e.message);
    return null;
  }
}

async function placeDetails(placeId) {
  const res = await fetchWithTimeout(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,websiteUri,googleMapsUri',
      },
    },
    6000,
  );
  if (!res.ok) throw new Error(`Place details failed: HTTP ${res.status}`);
  const d = await res.json();
  return {
    source: 'places',
    placeId,
    name: (d.displayName && d.displayName.text) || '',
    address: d.formattedAddress || '',
    phone: d.nationalPhoneNumber || '',
    website: d.websiteUri || '',
    googleMapsUri: d.googleMapsUri || '',
  };
}

function mergeResults(primary, extra) {
  const seen = new Set(primary.map((r) => `${r.name}|${r.address}`.toLowerCase()));
  for (const r of extra) {
    const key = `${r.name}|${r.address}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      primary.push(r);
    }
  }
  return primary;
}

// Distance between two points in km (haversine).
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Read and validate an optional ?lat= &lng= from the request. Returns
// { lat, lng } or null when absent/invalid — search works without it.
function parseLatLng(req) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// --- Website email extraction -------------------------------------------
// Only emails the business itself publishes on its own homepage
// (mailto: links and page text). Never guessed, never from a directory.

function isPrivateIp(ip) {
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fec0:')) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1];
  const b = +m[2];
  return a === 0 || a === 10 || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function isPlausibleEmail(e) {
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false;
  if (/^(noreply|no-reply|donotreply|postmaster|abuse|mailer-daemon)@/.test(e)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|css|js|ico)$/.test(e)) return false;
  if (/@(example\.com|example\.org|example\.net|test\.com|localhost)$/.test(e)) return false;
  return true;
}

async function fetchWebsiteEmails(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    throw new Error('That website address does not look valid.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) website addresses are allowed.');
  if (u.username || u.password) throw new Error('Website addresses with a login in them are not allowed.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Local website addresses are not allowed.');
  }
  // Resolve the host and refuse private/reserved addresses (SSRF guard).
  const addrs = await dns.promises.lookup(host, { all: true }).catch(() => null);
  if (!addrs || !addrs.length) throw new Error('Could not reach that website.');
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That website address is not public.');
  }
  const res = await fetchWithTimeout(u.toString(), {
    headers: {
      'User-Agent': 'Comment Card (business lookup; contact hello@commentcard.app)',
      Accept: 'text/html,application/xhtml+xml,text/plain',
    },
    redirect: 'follow',
  }, 6000);
  if (!res.ok) throw new Error(`Website returned HTTP ${res.status}.`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
    throw new Error('That address is not a web page.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 512 * 1024) throw new Error('That page is too large to scan.');
  const html = buf.toString('utf8');
  const found = [];
  const mailtos = [...html.matchAll(/href\s*=\s*["']mailto:([^"'?#\s]+)/gi)]
    .map((m) => decodeURIComponent(m[1]).trim().toLowerCase());
  const raw = [...html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)]
    .map((m) => m[0].toLowerCase());
  for (const e of [...mailtos, ...raw]) {
    if (isPlausibleEmail(e) && !found.includes(e)) found.push(e);
  }
  const preferred = ['info@', 'contact@', 'hello@', 'support@', 'enquiries@', 'inquiries@', 'team@'];
  found.sort((a, b) => {
    const pa = preferred.findIndex((p) => a.startsWith(p));
    const pb = preferred.findIndex((p) => b.startsWith(p));
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) || a.localeCompare(b);
  });
  return found.slice(0, 5);
}

// ---------------------------------------------------------------------------
// App + auth
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1); // correct req.ip / secure cookies behind Render/Fly proxies
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

function createSession(businessId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, business_id, expires_at) VALUES (?, ?, ?)')
    .run(token, businessId, expiresAt);
  return token;
}

function authMiddleware(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  const row = db.prepare(`
    SELECT s.business_id, s.expires_at, b.id, b.slug, b.name, b.email, b.welcome_note, b.claimed
    FROM sessions s JOIN businesses b ON b.id = s.business_id
    WHERE s.token = ?
  `).get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  req.business = {
    id: row.business_id,
    slug: row.slug,
    name: row.name,
    email: row.email,
    welcome_note: row.welcome_note,
    claimed: row.claimed === 1,
  };
  next();
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function publicBusinessRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    email: row.email,
    claimed: row.claimed === 1,
  };
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

// Direct signup is kept for owners who want to pre-register before anyone
// comments. The normal path is consumer-first: a comment creates the page,
// and the owner claims it from the email / QR code.
app.post('/api/auth/signup', rateLimit(10, 60 * 1000), (req, res) => {
  const name = cleanStr(req.body.name, 120);
  const email = cleanStr(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!name) return res.status(400).json({ error: 'Business name is required.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (db.prepare('SELECT 1 FROM businesses WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'An account with that email already exists.' });
  }

  const slug = uniqueSlug(name);
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const info = db.prepare(
    'INSERT INTO businesses (slug, name, email, password_hash, claimed) VALUES (?, ?, ?, ?, 1)'
  ).run(slug, name, email, hash);

  const token = createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.status(201).json({
    business: { id: info.lastInsertRowid, slug, name, email, welcome_note: '', claimed: true },
  });
});

app.post('/api/auth/login', rateLimit(10, 60 * 1000), (req, res) => {
  const email = cleanStr(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  if (!row || !row.password_hash || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const token = createSession(row.id);
  setSessionCookie(res, token);
  res.json({
    business: {
      id: row.id, slug: row.slug, name: row.name, email: row.email,
      welcome_note: row.welcome_note, claimed: row.claimed === 1,
    },
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ business: req.business });
});

// ---------------------------------------------------------------------------
// Business lookup + claim API (consumer-first model)
// ---------------------------------------------------------------------------

// Search businesses already on Comment Card (by name).
app.get('/api/businesses/search', rateLimit(30, 60 * 1000), (req, res) => {
  const q = cleanStr(req.query.q, 120);
  if (!q || q.length < 2) return res.json({ businesses: [] });
  const rows = db.prepare(`
    SELECT slug, name, claimed FROM businesses
    WHERE name LIKE ? ORDER BY name ASC LIMIT 8
  `).all(`%${q}%`);
  res.json({
    businesses: rows.map((r) => ({ slug: r.slug, name: r.name, claimed: r.claimed === 1 })),
  });
});

// A consumer adds a business by name + email (the email is how the site
// knows where to send the "you have a comment" notification). Creates the
// public page on the fly in an unclaimed state, or returns the existing one.
app.post('/api/businesses/find-or-create', rateLimit(10, 60 * 1000), async (req, res) => {
  const name = cleanStr(req.body.name, 120);
  const email = cleanStr(req.body.email, 160).toLowerCase();
  const placeId = cleanStr(req.body.place_id, 160);
  const address = cleanStr(req.body.address, 300);
  let lat = parseFloat(req.body.lat);
  let lng = parseFloat(req.body.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) lat = null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) lng = null;

  if (!name) return res.status(400).json({ error: 'Business name is required.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter the business email address.' });

  let existing = null;
  if (placeId) {
    existing = db.prepare('SELECT * FROM businesses WHERE place_id = ?').get(placeId);
  }
  if (!existing) {
    existing = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  }
  if (existing) {
    // Backfill coordinates for businesses created before they were tracked.
    if (existing.lat == null || existing.lng == null) {
      const coords = (lat != null && lng != null) ? { lat, lng }
        : await geocodeBusiness([name, address || existing.address].filter(Boolean).join(', '));
      if (coords) {
        db.prepare('UPDATE businesses SET lat = ?, lng = ?, address = COALESCE(?, address) WHERE id = ?')
          .run(coords.lat, coords.lng, address || null, existing.id);
        existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(existing.id);
      }
    }
    return res.json({ business: publicBusinessRow(existing), created: false });
  }

  if (lat == null || lng == null) {
    const coords = await geocodeBusiness([name, address].filter(Boolean).join(', '));
    if (coords) { lat = coords.lat; lng = coords.lng; }
  }
  const slug = uniqueSlug(name);
  const claimToken = newClaimToken();
  const info = db.prepare(
    'INSERT INTO businesses (slug, name, email, place_id, lat, lng, address, claimed, claim_token) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(slug, name, email, placeId || null, lat, lng, address || null, claimToken);
  const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ business: publicBusinessRow(row), created: true });
});

// Claim page info (public — the token itself is the secret).
app.get('/api/claim/:token', (req, res) => {
  const biz = db.prepare('SELECT slug, name, email, claimed FROM businesses WHERE claim_token = ?')
    .get(req.params.token);
  if (!biz) return res.status(404).json({ error: 'That claim link is not valid.' });
  res.json({ business: { slug: biz.slug, name: biz.name, email: biz.email, claimed: biz.claimed === 1 } });
});

// Claim the business: set the owner password and mark it claimed.
// The email must match the one the notification was sent to.
app.post('/api/claim/:token', rateLimit(10, 60 * 1000), (req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE claim_token = ?').get(req.params.token);
  if (!biz) return res.status(404).json({ error: 'That claim link is not valid.' });
  if (biz.claimed === 1) {
    return res.status(400).json({ error: 'This page is already claimed. Log in to your dashboard instead.' });
  }
  const name = cleanStr(req.body.name, 120);
  const email = cleanStr(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!name) return res.status(400).json({ error: 'Business name is required.' });
  if (email !== biz.email.toLowerCase()) {
    return res.status(400).json({ error: 'Use the email address the notification was sent to.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (biz.password_hash && !bcrypt.compareSync(password, biz.password_hash)) {
    return res.status(401).json({ error: 'That password does not match this business.' });
  }
  const hash = biz.password_hash || bcrypt.hashSync(password, BCRYPT_ROUNDS);
  db.prepare('UPDATE businesses SET name = ?, password_hash = ?, claimed = 1 WHERE id = ?')
    .run(name, hash, biz.id);

  const token = createSession(biz.id);
  setSessionCookie(res, token);
  const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(biz.id);
  res.json({ business: publicBusinessRow(row) });
});

// ---------------------------------------------------------------------------
// Lookup cascade API — Places, then Nominatim, then the business website
// ---------------------------------------------------------------------------

app.get('/api/places/search', rateLimit(30, 60 * 1000), async (req, res) => {
  const q = cleanStr(req.query.query, 120);
  if (!q || q.length < 2) return res.json({ placesEnabled: !!PLACES_KEY, results: [] });
  const loc = parseLatLng(req);
  let results = [];
  let error = null;
  if (PLACES_KEY) {
    try {
      results = await searchPlaces(q, loc);
    } catch (e) {
      console.error('Places search failed:', e.message);
      error = 'Google Places lookup failed; showing other results.';
    }
  }
  if (!results.length) {
    try {
      results = mergeResults(results, await searchNominatim(q, loc));
    } catch (e) {
      console.error('Nominatim search failed:', e.message);
      if (!error) error = 'Business lookup is unavailable right now — you can still add the business manually.';
    }
  }
  if (loc) {
    // Nearest first: attach each result's distance, then sort by it.
    // Results without coordinates sort last.
    for (const r of results) {
      if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
        r.distanceKm = Math.round(haversineKm(loc.lat, loc.lng, r.lat, r.lng) * 10) / 10;
        r.distanceMi = Math.round(r.distanceKm * 0.621371 * 10) / 10;
      }
    }
    results.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }
  res.json({ placesEnabled: !!PLACES_KEY, locationUsed: !!loc, results: results.slice(0, 8), error });
});

app.get('/api/places/details', rateLimit(30, 60 * 1000), async (req, res) => {
  const placeId = cleanStr(req.query.placeId, 160);
  if (!placeId) return res.status(400).json({ error: 'placeId is required.' });
  if (!PLACES_KEY) return res.json({ placesEnabled: false, place: null });
  try {
    const place = await placeDetails(placeId);
    res.json({ placesEnabled: true, place });
  } catch (e) {
    console.error('Place details failed:', e.message);
    res.json({ placesEnabled: true, place: null, error: 'Could not load business details.' });
  }
});

// Scan a business's own homepage for email addresses it publishes itself.
app.get('/api/lookup/emails', rateLimit(10, 60 * 1000), async (req, res) => {
  const url = cleanStr(req.query.url, 500);
  if (!url) return res.status(400).json({ error: 'url is required.' });
  try {
    const emails = await fetchWebsiteEmails(url);
    res.json({ website: url, emails });
  } catch (e) {
    res.json({ website: url, emails: [], error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Public API — no login needed
// ---------------------------------------------------------------------------

// Business info + public feed for /b/<slug>
app.get('/api/public/:slug', async (req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(req.params.slug);
  if (!biz) return res.status(404).json({ error: 'Business not found.' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const rows = db.prepare(`
    SELECT * FROM comments
    WHERE business_id = ? AND hidden = 0 AND status IN ('new', 'noted', 'acted_on')
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(biz.id, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM comments
    WHERE business_id = ? AND hidden = 0 AND status IN ('new', 'noted', 'acted_on')
  `).get(biz.id).c;

  const business = {
    slug: biz.slug,
    name: biz.name,
    welcome_note: biz.welcome_note,
    claimed: biz.claimed === 1,
  };
  if (biz.claimed !== 1 && biz.claim_token) {
    const claimUrl = claimUrlFor(req, biz);
    business.claim_url = claimUrl;
    try {
      business.claim_qr = await claimQrDataUrl(claimUrl);
    } catch (e) {
      console.error('QR generation failed:', e.message);
    }
  }

  res.json({ business, comments: attachReplies(rows), total });
});

// Submit a comment to a business (public, no login)
app.post('/api/public/:slug/comments', rateLimit(30, 60 * 1000), async (req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(req.params.slug);
  if (!biz) return res.status(404).json({ error: 'Business not found.' });

  const kind = KINDS.includes(req.body.kind) ? req.body.kind : null;
  const area = AREAS.includes(req.body.area) ? req.body.area : null;
  const text = cleanStr(req.body.text, 2000);
  const betterText = cleanStr(req.body.better_text, 1000);
  const visitFrequency = VISIT_FREQUENCIES.includes(req.body.visit_frequency)
    ? req.body.visit_frequency : '';
  const name = cleanStr(req.body.name, 80);
  const contact = cleanStr(req.body.contact, 160);

  if (!kind) return res.status(400).json({ error: 'Choose what kind of comment this is.' });
  if (!area) return res.status(400).json({ error: 'Choose which part of the visit this is about.' });
  if (!text) return res.status(400).json({ error: 'Write your comment first.' });

  // 20-mile rule: comments only come from people near the business, to
  // keep out-of-area spam out. The commenter's location rides along with
  // the form; the business's coordinates were stored when its page was
  // created (or are geocoded now if they are missing).
  let bizLat = biz.lat;
  let bizLng = biz.lng;
  if (bizLat == null || bizLng == null) {
    const coords = await geocodeBusiness([biz.name, biz.address].filter(Boolean).join(', '));
    if (coords) {
      bizLat = coords.lat; bizLng = coords.lng;
      db.prepare('UPDATE businesses SET lat = ?, lng = ? WHERE id = ?').run(bizLat, bizLng, biz.id);
    }
  }
  if (bizLat != null && bizLng != null) {
    let cLat = parseFloat(req.body.lat);
    let cLng = parseFloat(req.body.lng);
    if (!Number.isFinite(cLat) || cLat < -90 || cLat > 90) cLat = null;
    if (!Number.isFinite(cLng) || cLng < -180 || cLng > 180) cLng = null;
    if (cLat == null || cLng == null) {
      return res.status(403).json({ error: `To leave a comment, share your location — we only accept comments from within ${COMMENT_MAX_MILES} miles of this business.` });
    }
    const distMi = haversineKm(bizLat, bizLng, cLat, cLng) * 0.621371;
    if (distMi > COMMENT_MAX_MILES) {
      return res.status(403).json({ error: `This business is about ${Math.round(distMi)} miles from you — comments only come from within ${COMMENT_MAX_MILES} miles, to keep out-of-area spam out.` });
    }
  } else {
    console.log(`Comment on "${biz.name}" (${biz.slug}) accepted without a distance check — business location unknown.`);
  }

  const info = db.prepare(`
    INSERT INTO comments
      (business_id, kind, area, text, better_text, visit_frequency, name, contact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(biz.id, kind, area, text, betterText, visitFrequency, name, contact);

  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);

  // First comment on an unclaimed business: tell the business it has a
  // comment, with the claim link. Later comments don't re-notify.
  const count = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE business_id = ?')
    .get(biz.id).c;
  if (biz.claimed !== 1 && count === 1) {
    const claimUrl = claimUrlFor(req, biz);
    const publicUrl = `${publicOrigin(req)}/b/${biz.slug}`;
    const email = claimNotificationEmail(
      { name: biz.name }, { ...row, kind, area }, claimUrl, publicUrl,
    );
    await sendBusinessEmail(biz.email, email.subject, email.text);
  }

  res.status(201).json({ comment: { ...publicComment(row), replies: [] } });
});

// Discover feed — latest public suggestions across all businesses
app.get('/api/discover', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const rows = db.prepare(`
    SELECT c.*, b.name AS business_name, b.slug AS business_slug
    FROM comments c JOIN businesses b ON b.id = c.business_id
    WHERE c.hidden = 0 AND c.status IN ('new', 'noted', 'acted_on')
    ORDER BY c.created_at DESC, c.id DESC LIMIT ?
  `).all(limit);
  res.json({
    comments: attachReplies(rows).map((c, i) => ({
      ...c,
      business_name: rows[i].business_name,
      business_slug: rows[i].business_slug,
    })),
  });
});

// ---------------------------------------------------------------------------
// Dashboard API — login required, scoped to the logged-in business only
// ---------------------------------------------------------------------------

app.get('/api/comments', authMiddleware, (req, res) => {
  const { status, kind, q } = req.query;
  const conditions = ['business_id = ?'];
  const params = [req.business.id];
  if (STATUSES.includes(status)) { conditions.push('status = ?'); params.push(status); }
  if (KINDS.includes(kind)) { conditions.push('kind = ?'); params.push(kind); }
  if (typeof q === 'string' && q.trim()) {
    conditions.push('(text LIKE ? OR better_text LIKE ? OR name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT * FROM comments WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
  `).all(...params);
  // attachReplies preserves row order, so index i lines up with rows[i].
  res.json({
    comments: attachReplies(rows).map((c, i) => ({
      ...c,
      contact: rows[i].contact,
      hidden: rows[i].hidden === 1,
    })),
  });
});

app.get('/api/comments/stats', authMiddleware, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE business_id = ?')
    .get(req.business.id).c;
  const unread = db.prepare("SELECT COUNT(*) AS c FROM comments WHERE business_id = ? AND status = 'new'")
    .get(req.business.id).c;
  const byKind = db.prepare(`
    SELECT kind, COUNT(*) AS c FROM comments WHERE business_id = ? GROUP BY kind
  `).all(req.business.id);
  const byArea = db.prepare(`
    SELECT area, COUNT(*) AS c FROM comments
    WHERE business_id = ? AND status != 'archived'
    GROUP BY area ORDER BY c DESC
  `).all(req.business.id);
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS c FROM comments WHERE business_id = ? GROUP BY status
  `).all(req.business.id);
  res.json({
    total,
    unread,
    mostMentionedArea: byArea.length ? byArea[0].area : null,
    byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
    byArea: Object.fromEntries(byArea.map((r) => [r.area, r.c])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
  });
});

// Post an owner reply to a comment — it shows publicly under the comment.
app.post('/api/comments/:id/replies', authMiddleware, rateLimit(30, 60 * 1000), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM comments WHERE id = ? AND business_id = ?')
    .get(id, req.business.id);
  if (!row) return res.status(404).json({ error: 'Comment not found.' });
  const text = cleanStr(req.body.text, 1000);
  if (!text) return res.status(400).json({ error: 'Write your reply first.' });
  const info = db.prepare(
    'INSERT INTO replies (comment_id, business_id, text) VALUES (?, ?, ?)'
  ).run(id, req.business.id, text);
  res.status(201).json({
    reply: {
      id: info.lastInsertRowid,
      text,
      created_at: new Date().toISOString(),
      business_name: req.business.name,
    },
  });
});

app.delete('/api/comments/:id/replies/:replyId', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const replyId = parseInt(req.params.replyId, 10);
  const info = db.prepare(
    'DELETE FROM replies WHERE id = ? AND comment_id = ? AND business_id = ?'
  ).run(replyId, id, req.business.id);
  if (!info.changes) return res.status(404).json({ error: 'Reply not found.' });
  res.json({ ok: true });
});

app.patch('/api/comments/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM comments WHERE id = ? AND business_id = ?')
    .get(id, req.business.id);
  if (!row) return res.status(404).json({ error: 'Comment not found.' });

  const updates = [];
  const params = [];
  if (STATUSES.includes(req.body.status)) {
    updates.push('status = ?');
    params.push(req.body.status);
  }
  if (typeof req.body.hidden === 'boolean') {
    updates.push('hidden = ?');
    params.push(req.body.hidden ? 1 : 0);
  }
  if (!updates.length) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  params.push(id, req.business.id);
  db.prepare(`UPDATE comments SET ${updates.join(', ')} WHERE id = ? AND business_id = ?`)
    .run(...params);
  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  const withReplies = attachReplies([updated])[0];
  res.json({
    comment: { ...withReplies, contact: updated.contact, hidden: updated.hidden === 1 },
  });
});

app.delete('/api/comments/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM comments WHERE id = ? AND business_id = ?')
    .run(id, req.business.id);
  if (!info.changes) return res.status(404).json({ error: 'Comment not found.' });
  res.json({ ok: true });
});

app.get('/api/settings', authMiddleware, (req, res) => {
  res.json({ business: req.business });
});

app.patch('/api/settings', authMiddleware, (req, res) => {
  const name = cleanStr(req.body.name, 120);
  const welcomeNote = cleanStr(req.body.welcome_note, 500);
  if (!name) return res.status(400).json({ error: 'Business name is required.' });
  db.prepare('UPDATE businesses SET name = ?, welcome_note = ? WHERE id = ?')
    .run(name, welcomeNote, req.business.id);
  const row = db.prepare('SELECT slug, name, email, welcome_note FROM businesses WHERE id = ?')
    .get(req.business.id);
  res.json({ business: { id: req.business.id, ...row } });
});

// ---------------------------------------------------------------------------
// Pages + static assets
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/b/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card.html')));
app.get('/claim/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'claim.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Comment Card running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Email: ${mailer ? `SMTP via ${process.env.SMTP_HOST}` : 'not configured — notification emails will be logged to the console'}`);
  console.log(`Google Places lookup: ${PLACES_KEY ? 'enabled' : 'not configured — falling back to OpenStreetMap Nominatim'}`);
});
