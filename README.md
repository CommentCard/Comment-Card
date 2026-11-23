# Comment Card

**Got something to say about that place? Say it.** Comment Card lets
customers tell a business what they'd change — honest and out in the
open. No stars, no reviews: a customer drops a comment card, it shows up on
the business's public feed like scrolling through Instagram comments, and
the owner can answer it right back.

- **Consumer-first:** nobody signs up first. A customer finds any business
  (or adds it with its name and email), leaves a comment, and it's live.
- **Claim flow:** the first comment on a new business emails the business —
  "You have a comment on Comment Card" — with a claim link and a QR code.
  The owner claims the page from that link and can reply to comments.
- **Owner replies:** replies from the business show publicly under the
  comment, clearly labeled as from the business.
- **Business lookup:** type a name and the lookup tries Google Places, then
  OpenStreetMap, then the business's own website to find a published email.
- **Self-hosted:** plain Node.js + SQLite. The database is a single file.

## How it works

1. A customer opens the site, types a business name in the lookup box, and
   picks it — or adds it with the business name and email.
2. They fill in the paper comment card: what kind of comment (bugged me /
   I'd change / an idea), which part of the visit, the comment itself, what
   would have made it better, how often they visit, and an optional
   name/contact. It appears on the business's public feed right away.
3. If it's the business's first comment, the site emails the business with
   the comment and a claim link. The business's public page also shows a
   QR code for the same link.
4. The owner follows the link (or scans the code), sets a password, and
   lands in a simple inbox: here's what your customers are telling you.
   They can reply publicly, mark cards noted or acted on, or hide/archive
   anything off-topic.

## Run it locally

Requirements: **Node.js 20+** (developed and tested on Node 24).

```bash
npm install
npm start
```

Then open http://localhost:3000

- Search for a business in the lookup box, add one, submit a comment, and
  watch it appear in the public feed and in the latest-comments feed.
- The database is created automatically at `data/comment-card.db`.
  To start over, stop the server and delete that file.
- Set `PORT=4000 npm start` to run on a different port.
- Set `COOKIE_SECURE=1` only when serving over HTTPS (see deployment below).
  If you set it on plain `http://localhost`, login cookies will not stick.
- Optional: copy `.env.example` to `.env` for email + Places settings
  (see below). `.env` is gitignored — never commit keys or passwords.

## Email setup (optional but recommended)

The claim notification is the only email the app sends. Configure it with
environment variables:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
EMAIL_FROM=Comment Card <you@gmail.com>
```

Free options:

- **Gmail app password:** in your Google account, turn on 2-Step
  Verification, then create an App Password (Google Account → Security →
  App passwords → Mail). Use it as `SMTP_PASS`. Note Gmail's sending
  limits (roughly 500 messages/day on a free account) — plenty for this.
- **Resend:** create a free account, verify a domain (or use their
  onboarding sender while testing), and use their SMTP settings
  (`smtp.resend.com`, port 465, user `resend`, pass = your API key).
- **SendGrid:** free tier (100 emails/day). Use `smtp.sendgrid.net`,
  port 587, user `apikey`, pass = your SendGrid API key.

**If SMTP is not configured, nothing breaks:** the server logs the full
email text to the console (look for `--- EMAIL (no SMTP configured — would
send) ---`), and the claim link + QR code are still shown on the
business's public page, so the whole flow is demoable without email.

You can also set `PUBLIC_URL=https://your-domain.com` so claim links and
QR codes use your real domain even behind a proxy. (On Render, the app
picks up `RENDER_EXTERNAL_URL` automatically.)

## Business lookup — how it works

The lookup box on the landing page autocompletes as you type (2+ characters,
debounced ~300ms). It runs a cascade, server-side only — the browser never
sees any API key:

1. **Google Places API (New)** — when `GOOGLE_PLACES_API_KEY` is set.
   Returns name, address, and (via Place Details) phone and website.
2. **OpenStreetMap Nominatim** — free, no key. Used when Places has no
   key, fails, or finds nothing. Respects the Nominatim usage policy:
   identifies the app in the `User-Agent`, max 1 request/second, 5-second
   timeout. Returns name, address, and phone/website when OpenStreetMap
   has them.
3. **The business's own website** — once a website URL is known, the
   server fetches the homepage (6-second timeout, follows redirects,
   512 KB cap, SSRF guards: only public http(s) hosts) and extracts email
   addresses the business itself publishes there (from `mailto:` links and
   page text). If several are found, ones like `info@`, `contact@`,
   `hello@` are shown first and the commenter picks one — or types their
   own. **Nothing is ever guessed or invented.**
4. **Manual entry** — if no source returns anything, the commenter just
   types the business name and email. The dropdown always offers
   "No matches — add this business manually."

**One honest limit: Google Places does not return business email
addresses.** Neither does Nominatim. That's why the email field is still
entered by the commenter — the website scan is the best shot at filling
it in automatically, and the business's website link is shown next to the
email field so the commenter can find the address there if needed. The
commenter can always correct the email before posting.

**Localized, nearest first.** The lookup asks the visitor's browser for
their location (with permission) and sorts results nearest first, showing
the distance ("4.9 mi away"). Google gets a 25 km location bias;
Nominatim searches a tight box around the searcher first and widens it
only if few results come back, with the searcher's area named in the query
as a fallback — otherwise a big city's matches crowd out the local ones.
Without location, search works as before, just unsorted. A far-away
search still works: the box keeps widening until something is found.

**20-mile rule.** Comments only come from within 20 miles of the
business, to keep out-of-area spam out. The business's coordinates are
stored when its page is created (from the lookup result, or geocoded from
its name/address); the commenter's location rides along with the form.
Posting from farther than 20 miles — or without sharing a location — is
refused with a plain message. If a business's location can't be found at
all, its comments are accepted (the rule can't be checked). Change the
distance with the `COMMENT_MAX_MILES` env var. One honest limit: a
location sent by a browser can be faked by someone determined enough to
do it on purpose — this stops casual overseas spam, not a deliberate
attacker.

### Google Places API key setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or pick one) and enable billing (Places API requires a billing
   account; the first requests each month are free).
2. Enable the **Places API (New)** (APIs & Services → Library → search
   "Places API (New)").
3. Create an API key (APIs & Services → Credentials → Create credentials →
   API key). Restrict it: under "API restrictions" pick only Places API,
   and under "Application restrictions" add your site's HTTP referrers
   (the key is only ever sent server-to-server from your host, so also
   consider restricting by IP).
4. Set `GOOGLE_PLACES_API_KEY=your-key` in your environment (or `.env`
   locally, `render.yaml` env vars on Render).

Without the key, the lookup still works — it just starts at step 2
(Nominatim) instead of step 1.

## Deploy to Render (free tier) — step by step

Render's free tier is enough to start: a free web service plus a 1 GB
persistent disk for the SQLite file.

**Accounts you need to create first (all free):**

1. **GitHub** (https://github.com/signup) — to hold the code. Render deploys
   from a GitHub repo.
2. **Render** (https://dashboard.render.com/register) — sign up with your
   GitHub account so it can see your repos.

**Steps:**

1. Push this folder to a GitHub repository. From this folder:
   ```bash
   git init
   git add .
   git commit -m "Comment Card"
   git branch -M main
   git remote add origin https://github.com/<your-username>/comment-card.git
   git push -u origin main
   ```
   (Create the empty `comment-card` repo on GitHub first, in the web UI.
   Upload the *contents* of this folder, not the folder itself — Render
   looks for `render.yaml` and the code at the repo root.)
2. In Render, click **New → Blueprint**, and pick the `comment-card` repo.
   Render reads `render.yaml` and fills in the settings (Node runtime,
   free plan, `npm install` build, `npm start`, persistent disk at
   `/var/data`).
3. Add the optional environment variables in the Render dashboard
   (Environment → Add Environment Variable): `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `GOOGLE_PLACES_API_KEY`.
4. Click **Create**. The first deploy takes a few minutes.
5. Render gives you a URL like `https://comment-card-xxxx.onrender.com`.
   Open it, find a business, leave a comment — the flow works end to end
   without any account. (Render sets `COOKIE_SECURE=1` for you in
   `render.yaml`, because your site runs over HTTPS.)

**Free-tier notes:**

- Free web services **sleep after 15 minutes with no traffic** and take
  ~30–60 seconds to wake on the next visit. That's fine for getting started;
  if it bothers you, Render's paid Starter plan ($7/month) never sleeps.
- The 1 GB disk in `render.yaml` holds the SQLite database. **Do not remove
  the disk** — without it, every redeploy would wipe your businesses and
  comments.

## Deploy to Fly.io (alternative)

1. Create a free Fly.io account at https://fly.io and install the CLI:
   `curl -L https://fly.io/install.sh | sh`
2. Log in: `fly auth login`
3. From this folder: `fly launch --no-deploy` — accept the defaults (it will
   pick up `fly.toml` and the `Dockerfile`).
4. Create the data volume (one-time):
   `fly volumes create comment_card_data --size 1 --region <your region>`
   (Pick the region nearest your customers, e.g. `sea` for Seattle.)
5. Set any secrets: `fly secrets set SMTP_HOST=... SMTP_USER=... SMTP_PASS=... GOOGLE_PLACES_API_KEY=...`
6. `fly deploy` — Fly gives you a `https://comment-card.fly.dev` URL.

## Back up the database

Everything — businesses, logins, comments, replies — lives in one file:

- Locally: `data/comment-card.db`
- On Render: on the disk at `/var/data/comment-card.db`
  (Render Dashboard → your service → Shell, then `cp /var/data/comment-card.db /tmp/` and download it, or use the Shell to copy it somewhere safe.)
- On Fly.io: `fly ssh sftp get /data/comment-card.db ./comment-card-backup.db`

**Back it up regularly.** Copy the file while the server is stopped, or copy
the `-wal` file alongside it — simplest is to stop the service, copy
`comment-card.db`, and restart. Keep backups somewhere other than the server.

To restore: stop the server, replace `comment-card.db` with your backup, and
restart.

## Security notes

- Passwords are hashed with **bcrypt** (12 rounds). Plaintext passwords are
  never stored. Unclaimed businesses have no password until claimed.
- Claim links use a random 64-hex-character token — unguessable, but
  anyone who sees the link (or the QR code on the public page) can claim
  the page, by design. Once claimed, the link stops working.
- Login sessions are random tokens in **httpOnly cookies** (JavaScript can't
  read them), stored in the database and expiring after 30 days.
- Every dashboard request is checked against the logged-in business — a
  business can only see, reply to, or change **its own** comments and
  replies.
- Public comment pages **never expose** a commenter's contact details, and
  never expose other businesses' data. Business emails are not exposed
  publicly either — the claim link is the only owner-facing thing on a
  public page.
- All database queries use parameters — no string-built SQL.
- The Google Places API key is **server-side only** and never sent to the
  browser. Website fetching for email extraction has SSRF guards (public
  http(s) hosts only, resolved IPs checked against private ranges, size
  and timeout caps).
- Basic rate limiting is built in (10 auth/claim attempts/minute per IP,
  30 public comments and lookup requests/minute per IP, 10 website email
  scans/minute per IP).
- This is a small, self-hosted app, not a hardened SaaS platform. Before
  taking real customer data, use HTTPS (Render and Fly both provide it),
  keep Node and dependencies updated (`npm audit` / `npm update`), and
  consider adding an admin way to reset a business password (not built in
  yet — today a forgotten password means deleting the row or editing the
  database directly).

## File layout

```
comment-card-app/
├── server.js           # Express app: auth, claim flow, lookup cascade, replies
├── package.json        # Pinned dependencies (express, better-sqlite3, bcrypt,
│                       #   nodemailer, qrcode)
├── public/
│   ├── index.html      # Landing: tagline, lookup box, latest-comments feed
│   ├── card.html       # Public business page: claim QR, paper-card form, feed
│   ├── claim.html      # Claim page: /claim/<token>
│   ├── dashboard.html  # Owner inbox: comments, replies, hide/archive
│   ├── app.js          # Frontend logic (plain JS, no dependencies)
│   ├── styles.css      # One design system: coral / teal / bold yellow,
│   │                   #   paper-card form, mobile-first
│   └── logo.webp       # Comment Card logo (header + favicon)
├── data/
│   └── comment-card.db # SQLite database (created on first run; gitignored)
├── Dockerfile          # Container build (used by Fly.io)
├── render.yaml         # One-click Render deploy (free tier + disk)
├── fly.toml            # Fly.io deploy config
└── README.md           # This file
```

## Data model

- **businesses** — id, slug (unique, from the business name), name, email
  (unique), password_hash (null until claimed), place_id (Google Places or
  `osm:` reference, nullable), claimed (0/1), claim_token (random hex;
  claiming is refused once claimed=1),
  welcome_note, created_at
- **comments** — id, business_id, kind (`bugged` / `change` / `idea`), area
  (`service`, `wait-time`, `price`, `cleanliness`, `food-quality`, `staff`,
  `other`), text, better_text, visit_frequency, name, contact, status
  (`new` / `noted` / `acted_on` / `archived`), hidden (0/1 — hidden from
  the public feed), created_at
- **replies** — id, comment_id, business_id, text, created_at. Shown
  publicly under the comment, labeled as from the business.
- **sessions** — token, business_id, created_at, expires_at

Public feeds show only comments with `hidden = 0` and status `new`, `noted`,
or `acted_on`. Archived comments and hidden comments never appear publicly.
Owner replies show under their comment in every public feed.

## Look and feel

Fun, consumer-first, modern — built on the logo's palette: coral red,
teal, and bold yellow. Rounded cards, generous spacing, big readable type,
playful but clean. The landing page leads with "Got something to say about
that place? Say it." The comment form keeps the paper-card charm of
the original shareable version — lined paper, a red margin line, punch
holes, and a handwritten comment box — in the new colors. The dashboard is
deliberately calmer and simpler: it's an inbox, not management software.
Mobile-first throughout.
