# Comment Card

**Honest feedback, not reviews.** Comment Card lets customers leave a business
private, honest comments — what bugged them, what they'd change, or an idea —
and shows each business's suggestions as a public, scrollable feed, like
scrolling through Instagram comments. No stars, no public review pages.

- **Multi-tenant:** any business signs up and gets its own public page
  (`/b/your-business-name`) and its own private inbox.
- **Public feed:** anyone can open a business's page, scroll the suggestions
  (newest first), and add their own — no login needed to comment.
- **Private dashboard:** the business logs in to read everything, see
  patterns (most-mentioned area, counts by type), filter/search, and mark
  cards noted, acted on, or archived. Archiving — or the explicit
  "Hide from public" button — removes a suggestion from the public feed.
- **Self-hosted:** plain Node.js + SQLite. No Muse, no third-party APIs, no
  external services at runtime. The database is a single file.

## How it works

1. A business signs up at `/` with a name, email, and password.
2. It gets a public link, e.g. `https://your-app.onrender.com/b/harbor-lane-bakery`.
   Print it on receipts or table cards, or share it anywhere.
3. Customers open the link, scroll the suggestions, and leave their own.
   A new suggestion appears in the public feed right away.
4. The business logs in at `/dashboard` to manage everything.

## Run it locally

Requirements: **Node.js 20+** (developed and tested on Node 24).

```bash
npm install
npm start
```

Then open http://localhost:3000

- Sign up a business, copy its public link, submit a comment, and watch it
  appear in the public feed and in the dashboard inbox.
- The database is created automatically at `data/comment-card.db`.
  To start over, stop the server and delete that file.
- Set `PORT=4000 npm start` to run on a different port.
- Set `COOKIE_SECURE=1` only when serving over HTTPS (see deployment below).
  If you set it on plain `http://localhost`, login cookies will not stick.

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
   (Create the empty `comment-card` repo on GitHub first, in the web UI.)
2. In Render, click **New → Web Service**, and pick the `comment-card` repo.
3. Render reads `render.yaml` in the repo and fills in the settings for you
   (Node runtime, free plan, `npm install` build, `npm start`, and a
   persistent disk at `/var/data`).
4. Click **Create Web Service**. The first deploy takes a few minutes.
5. Render gives you a URL like `https://comment-card-xxxx.onrender.com`.
   Open it, sign up a business, and share its public link.
   (Render sets `COOKIE_SECURE=1` for you in `render.yaml`, because your
   site runs over HTTPS.)

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
5. `fly deploy` — Fly gives you a `https://comment-card.fly.dev` URL.

## Back up the database

Everything — businesses, logins, comments — lives in one file:

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
  never stored.
- Login sessions are random tokens in **httpOnly cookies** (JavaScript can't
  read them), stored in the database and expiring after 30 days.
- Every dashboard request is checked against the logged-in business — a
  business can only see or change **its own** comments and settings.
- Public comment pages **never expose** a commenter's contact details, and
  never expose other businesses' data.
- All database queries use parameters — no string-built SQL.
- Basic rate limiting is built in (10 auth attempts/minute per IP,
  30 public comments/minute per IP).
- This is a small, self-hosted app, not a hardened SaaS platform. Before
  taking real customer data, use HTTPS (Render and Fly both provide it),
  keep Node and dependencies updated (`npm audit` / `npm update`), and
  consider adding an admin way to reset a business password (not built in
  yet — today a forgotten password means deleting the row or editing the
  database directly).

## File layout

```
comment-card-app/
├── server.js           # Express app: auth, public feed API, dashboard API
├── package.json        # Pinned dependencies (express, better-sqlite3, bcrypt)
├── public/
│   ├── index.html      # Landing page: signup/login + discover feed
│   ├── card.html       # Public business page: comment form + public feed
│   ├── dashboard.html  # Private business dashboard: inbox, patterns, settings
│   ├── app.js          # Frontend logic (plain JS, no dependencies)
│   └── styles.css      # Paper comment-card styling
├── data/
│   └── comment-card.db # SQLite database (created on first run; gitignored)
├── Dockerfile          # Container build (used by Fly.io)
├── render.yaml         # One-click Render deploy (free tier + disk)
├── fly.toml            # Fly.io deploy config
└── README.md           # This file
```

## Data model

- **businesses** — id, slug (unique, from the business name), name, email
  (unique), password_hash, welcome_note, created_at
- **comments** — id, business_id, kind (`bugged` / `change` / `idea`), area
  (`service`, `wait-time`, `price`, `cleanliness`, `food-quality`, `staff`,
  `other`), text, better_text, visit_frequency, name, contact, status
  (`new` / `noted` / `acted_on` / `archived`), hidden (0/1 — hidden from
  the public feed), created_at
- **sessions** — token, business_id, created_at, expires_at

Public feeds show only comments with `hidden = 0` and status `new`, `noted`,
or `acted_on`. Archived comments and hidden comments never appear publicly.
