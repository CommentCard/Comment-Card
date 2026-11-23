// Comment Card — multi-tenant private feedback app with public suggestion feeds.
// Stack: Node.js + Express + SQLite (better-sqlite3). No external services.
// Run:  npm install && npm start   (listens on PORT, default 3000)

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
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
    password_hash TEXT NOT NULL,
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
`);

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const KINDS = ['bugged', 'change', 'idea'];
const AREAS = ['service', 'wait-time', 'price', 'cleanliness', 'food-quality', 'staff', 'other'];
const STATUSES = ['new', 'noted', 'acted_on', 'archived'];
const VISIT_FREQUENCIES = ['first-time', 'sometimes', 'regular', ''];
const FEED_STATUSES = ['new', 'noted', 'acted_on']; // archived never shows publicly

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

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
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
    SELECT s.business_id, s.expires_at, b.id, b.slug, b.name, b.email, b.welcome_note
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

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

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
    'INSERT INTO businesses (slug, name, email, password_hash) VALUES (?, ?, ?, ?)'
  ).run(slug, name, email, hash);

  const token = createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.status(201).json({
    business: { id: info.lastInsertRowid, slug, name, email, welcome_note: '' },
  });
});

app.post('/api/auth/login', rateLimit(10, 60 * 1000), (req, res) => {
  const email = cleanStr(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM businesses WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const token = createSession(row.id);
  setSessionCookie(res, token);
  res.json({
    business: { id: row.id, slug: row.slug, name: row.name, email: row.email, welcome_note: row.welcome_note },
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
// Public API — no login needed
// ---------------------------------------------------------------------------

// Business info + public feed for /b/<slug>
app.get('/api/public/:slug', (req, res) => {
  const biz = db.prepare('SELECT id, slug, name, welcome_note FROM businesses WHERE slug = ?')
    .get(req.params.slug);
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

  res.json({
    business: { slug: biz.slug, name: biz.name, welcome_note: biz.welcome_note },
    comments: rows.map(publicComment),
    total,
  });
});

// Submit a comment to a business (public, no login)
app.post('/api/public/:slug/comments', rateLimit(30, 60 * 1000), (req, res) => {
  const biz = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(req.params.slug);
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

  const info = db.prepare(`
    INSERT INTO comments
      (business_id, kind, area, text, better_text, visit_frequency, name, contact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(biz.id, kind, area, text, betterText, visitFrequency, name, contact);

  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ comment: publicComment(row) });
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
    comments: rows.map((r) => ({
      ...publicComment(r),
      business_name: r.business_name,
      business_slug: r.business_slug,
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
  res.json({ comments: rows.map(dashboardComment) });
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
  res.json({ comment: dashboardComment(updated) });
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

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Comment Card running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
