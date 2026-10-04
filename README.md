# Stock Ledger

Daily inventory tracker for After Hours Art Cafe — add stock, discard stock, and
reconcile today's actual count against what the ledger expects. Tracks daily,
monthly, and yearly movement, flags fast/slow-moving products, and separates
admin and staff access with per-person PIN logins.

This is the self-hosted version: Node.js/Express + SQLite, meant to run
alongside (or on the same Railway project as) your Support Reply Desk app.

## What changed from the artifact version

- **Real accounts, not a shared PIN.** Each staff member gets their own PIN
  under Admin → Team, so entries are attributed automatically — no more typing
  your name in on the count screen.
- **PINs are hashed** (bcrypt) and never stored in plain text.
- **Sessions use JWTs**, expire after 12 hours, and every write endpoint checks
  the role server-side — a staff account physically cannot call the admin/reset
  endpoints even if someone pokes at the API directly.
- **Data lives in SQLite**, not artifact storage, so it survives independent of
  claude.ai and can be backed up like any normal database file.

## Local setup

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET
npm start
```

Visit `http://localhost:3000`. First login uses PIN `1234` as Admin — change
it immediately under **Admin → Team**.

## Deploying to Railway

1. Push this folder to a GitHub repo (or a `stock-ledger` subfolder of your
   existing Support Reply Desk repo, if you'd rather run them as two services
   in one Railway project).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Add a **Volume** and mount it at `/data` — this is what keeps your
   inventory database across redeploys. Without a volume, Railway's
   filesystem resets on every deploy and you'd lose all your data.
4. Set these **Variables**:
   - `JWT_SECRET` — any long random string (e.g. generate one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `DATA_DIR` — `/data` (matching the volume mount path from step 3)
5. Railway auto-detects Node from `package.json` and runs `npm start`. It also
   sets `PORT` for you automatically — the app already reads it.
6. Once deployed, click **Generate Domain** to get a public HTTPS URL, and log
   in with PIN `1234` — then immediately go to Admin → Team and change it.

If you tell me to go ahead, I can also drive this deployment directly through
your connected Railway account instead of you doing it by hand — just say so
and I'll create the service, set the variables, and get you the live URL.

## Project structure

```
server.js          Express app entry point
db.js               SQLite schema + seed data
middleware/auth.js  JWT verification, admin-only gate
routes/
  auth.js           PIN login
  users.js          Team management (admin only)
  products.js        Product CRUD (admin only for writes)
  entries.js         Add / discard / count, admin edit & delete
  ledger.js           Daily/monthly/yearly ledger math, fast/slow movers
  admin.js            Settings, reset today, reset all
public/
  index.html, styles.css, app.js   Frontend (vanilla JS, no build step)
```

## How the ledger math works

Every product has a **starting stock**. For each day, in order:

```
opening   = previous day's closing stock
added     = sum of "add" entries that day
discarded = sum of "discard" entries that day
system    = opening + added - discarded
closing   = the physical count entered that day, if any — otherwise = system
variance  = physical count − system (only once a count is entered)
```

This runs day-by-day from the first-ever entry up to whatever date you're
viewing, so historical reports stay accurate even if you edit an entry from
three weeks ago.

**Fast/slow movers** rank products by total quantity added + discarded over a
7/30/90-day window — the higher the number, the more the product turns over.
Zero movement in the window is flagged as idle.

## Admin vs staff

- **Staff** can log in, add stock, discard stock, submit today's count, and
  view reports/movers.
- **Admin** can additionally manage products, manage team PINs, edit or
  delete *any* entry on *any* date, change settings, and reset data (today's
  entries only, or everything).
