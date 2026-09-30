# ORB trade journal

A self-hosted trading journal built around a 15-minute opening range breakout on NQ/MNQ.
Sign in, log trades by hand, or pull fills from Tradovate. Trades that Tradesyncer copies
to several accounts are grouped into one journal entry with each account's real fill and P&L.

Stack: Node 22 + Express, Postgres (a free Neon database in production; an embedded Postgres for local
use), vanilla JS front end. Runs on Render's free plan.

## Run it locally

```bash
cp .env.example .env        # optional for local use
npm install
npm start                   # http://localhost:3000
```

Create your account on the sign-in page. Without `DATABASE_URL`, data is stored in `./data/pgdata`.

## Getting trades in from Tradovate

There are three ways. Pick based on what Tradovate will let you use.

**1. CSV import (works today, every account).** In Tradovate open Reports → Performance, choose
the account and date range, download CSV, then upload it on the Accounts & Tradovate tab and pick
which journal account it belongs to. Re-importing the same file doesn't create duplicates, and fills
already pulled by sync are skipped. Timestamps are read in the timezone set under Settings, so set that
to match your Tradovate platform timezone. The CSV has no fees, so your per-contract commission
setting is applied.

**2. "Connect Tradovate" sign-in (OAuth) — the path for prop firm accounts.** Tradovate doesn't
give API keys to prop or evaluation accounts. Apps like TradingView and Tradesyncer reach those
accounts through Tradovate's OAuth, which requires an OAuth client (client ID + secret) issued to the
app through Tradovate's partner/vendor program. Once you have one:

- Register this redirect URI with Tradovate: `https://YOUR-DOMAIN/api/tradovate/oauth/callback`
- Set `TRADOVATE_CLIENT_ID` and `TRADOVATE_CLIENT_SECRET`, restart.
- On the Accounts tab choose "Prop firm / eval / sim accounts" and click Connect Tradovate. Sign in
  with the credentials your prop firm gave you. Repeat once per firm login (Tradeify, Lucid, Purdia).

Until those two variables are set, the Connect button stays disabled with a note explaining why.

**3. API key (personal live brokerage account only).** Tradovate issues API keys only on a live,
funded brokerage account with the API Access add-on. Enter username, password, CID and secret
under "Connect with an API key". The password and secret are encrypted at rest with `APP_SECRET`.

### What sync does

- Pulls accounts, fill pairs, fills, fees and contract specs, then builds one leg per
  account + contract + entry order (so scale-outs roll into one trade).
- Legs on different accounts that open within 90 seconds on the same instrument and side
  merge into one trade (your Tradesyncer copies).
- A trade you logged by hand merges with fills that open within 5 minutes of it, and keeps your notes.
- Price, size and side come from the fills. Your OR levels, stop, grade, confluence and notes stay yours.
- Synced trades show "Needs review" until you save them. Deleting a synced trade stops it from coming back.
- Runs in the background every `SYNC_MINUTES` (default 15), which also keeps tokens renewed.
  OAuth tokens that lapse (server off for hours) show "Reconnect needed". If older trades
  don't come through the API, backfill them with CSV import.

## Deploy for free (Render + Neon)

**1. Database (Neon, free).** Sign up at neon.tech, create a project, and copy the connection string
(starts with `postgresql://`). The free plan's 0.5 GB holds years of trades.

**2. Site (Render, free).** Push this folder to GitHub, then on render.com choose New → Blueprint and
pick the repo. When it asks for `DATABASE_URL`, paste the Neon string. `APP_SECRET` is generated for you.
Click Apply. Render sets the public URL automatically.

**What free means here:** the site sleeps after 15 minutes without visitors and takes about a minute
to wake on the next visit. Background sync only runs while it's awake, and it syncs 30 seconds after
waking, so open the journal after your session (or hit Sync now). Tradovate sign-in (OAuth) sessions
lapse if the site sleeps for more than about an hour and will show "Reconnect needed". CSV import
and API-key connections aren't affected.

**Already deployed the older disk version?** Replace the repo files with this version, then in Render
delete the old service and redo step 2. The old version needed a paid plan; this one doesn't.

**Docker (anywhere):**
```bash
docker build -t orb-journal .
docker run -p 3000:3000 -e DATABASE_URL=postgresql://... -e APP_URL=https://your-domain -e APP_SECRET=... orb-journal
```

## After you create your account

Set `ALLOW_SIGNUPS=false` and restart so nobody else can register on your site.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public base URL. Used for the OAuth redirect and secure cookies. |
| `DATABASE_URL` | Postgres connection string (Neon). Required on Render. |
| `DATA_DIR` | Local-only folder for the embedded database and `secret.key`. |
| `APP_SECRET` | 32+ chars. Encrypts Tradovate tokens and credentials. Keep it stable. Required when hosted. |
| `ALLOW_SIGNUPS` | `false` locks registration. |
| `SYNC_MINUTES` | Background sync interval, minimum 5. |
| `TRADOVATE_CLIENT_ID` / `TRADOVATE_CLIENT_SECRET` | OAuth client from Tradovate. |
| `TRADOVATE_AUTH_URL`, `TRADOVATE_OAUTH_TOKEN_URL`, `TRADOVATE_DEMO_URL`, `TRADOVATE_LIVE_URL` | Endpoint overrides, only if Tradovate gives you different ones. |

## Security notes

- Passwords are hashed with scrypt. Sessions are HttpOnly cookies, 30 days.
- State-changing API calls require an `X-Requested-With` header, which blocks cross-site form posts.
- Login and signup are rate limited. A strict Content-Security-Policy is set on every response.
- Neon keeps your data. If you lose `APP_SECRET`, trades survive but Tradovate connections must be redone.
