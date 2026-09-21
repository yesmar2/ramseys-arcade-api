# Skermix API

Leaderboard + tournament backend for [ramseys-arcade](https://github.com/yesmar2/ramseys-arcade).

Persistence is **Neon Postgres** (Drizzle ORM). The API no longer stores scores on the Render instance disk.

## Local

1. Create a free [Neon](https://neon.tech) project and copy the **pooled** connection string (`-pooler` host).
2. Copy `.env.example` → `.env` and set `DATABASE_URL`.
3. Install and run:

```bash
npm install
npm run db:migrate   # optional; also runs automatically on boot
npm run dev
```

Listens on `http://localhost:8787` (`PORT` / `HOST` env supported).

## Deploy (Render)

This repo includes `render.yaml`. From the [Render dashboard](https://dashboard.render.com/blueprints/new):

1. Connect the `yesmar2/ramseys-arcade-api` GitHub repo
2. Apply the Blueprint (free web service)
3. Set **`DATABASE_URL`** to your Neon **pooled** connection string (Dashboard → Environment)
4. After the Vercel frontend is live, set `CORS_ORIGIN` to that origin (e.g. `https://ramseys-arcade.vercel.app`)

Health check: `GET /health` — returns `{ ok, games, db }`. A missing/unreachable DB yields `503`.

### Launch checklist

- [ ] Neon project created; pooled `DATABASE_URL` set on Render
- [ ] API redeployed; `/health` shows `"db": true`
- [ ] Post a score, redeploy the API, confirm the score is still there
- [ ] `CORS_ORIGIN` / `GOOGLE_CLIENT_ID` / `FRONTEND_ORIGIN` match production

## Env

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | **Required.** Neon Postgres pooled URL |
| `PORT` | Listen port (Render sets this) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `CORS_ORIGIN` | Comma-separated allowed origins. If unset, reflects any origin (fine for first bring-up) |
| `GOOGLE_CLIENT_ID` | Google OAuth Web client ID for Sign in with Google (`POST /auth/google`) |
| `FRONTEND_ORIGIN` | Used when minting magic-link URLs (default `http://localhost:5173`) |
| `SEED_SAMPLE` | Set to `1` to fill empty boards with sample scores on boot (off by default) |
| `SEED_FORCE` | Set to `1` once to wipe boards/records/trophies on the next boot |
| `REQUIRE_RUN_TOKEN` | Set to `1` to reject scores with no `runId`. See below |
| `IP_HASH_SALT` | Salt for the address hash kept beside each score. Set it in production |
| `ADMIN_EMAILS` | Comma-separated emails allowed to use `/admin/*`. Unset means nobody |
| `ALLOW_MAGIC_LINK` | Set to `1` to re-enable email sign-in in production. Only do this once something actually sends the mail — see below |

## Anti-cheat

The games run in the browser, so a score is a claim. `POST /runs/start` returns
a single-use run id and records when the run opened; the score submitted with
that id is then checked against the time the server itself measured. Caps are
per game in `src/scoreLimits.ts`, set well above elite play — they exist to make
an instant jackpot impossible, not to police a good run.

All three score-writing surfaces go through it — the boards, the record books
and tournaments. A run is not single-use, because one game legitimately pays out
to several: it can be claimed once per surface (and once per tournament), while
record books read it without claiming, since a single run fills more than one.

Every score also keeps `run_id`, `duration_ms`, a salted `ip_hash` and a user
agent, so a suspect one can be looked into afterwards.

A score that is inside every cap and still obviously wrong gets **flagged**
rather than rejected — far past the rest of its board, or sitting at the edge of
what its run time allowed. Flagging never blocks a save; it writes the suspicion
down (and shouts it into the logs) for a person to settle at `/admin/flags`.

```bash
npm run smoke:anticheat          # 25 checks against a running dev API
npm run audit:runs -- snake 50   # recent scores with durations and rates
```

`REQUIRE_RUN_TOKEN` is **off** by default because a browser holding an older
build posts without a `runId` and must keep working through a deploy. Turn it on
once `audit:runs` shows new scores carrying run ids.

### Admin

With `ADMIN_EMAILS` set, that account can investigate and remediate. Everything
under `/admin` answers `404` to anyone else, so the surface is not discoverable.

| Route | Purpose |
|-------|---------|
| `GET /admin/whoami` | Confirm this session is an admin; includes the open flag count |
| `GET /admin/scores?game=&name=&limit=` | Recent scores with their audit trail |
| `POST /admin/scores/void` `{ids}` | Take scores off the boards |
| `GET /admin/flags?all=1` | Scores that looked wrong on the way in |
| `POST /admin/flags/:id/review` | Settle a flag, whichever way it went |
| `GET /admin/bans` | Current bans |
| `POST /admin/bans` `{name, reason?, purge?}` | Bar a tag; `purge` also wipes what it posted |
| `DELETE /admin/bans/:name` | Lift a ban |

A ban records the account behind the tag, so claiming a fresh tag is not a way
back on. Trophies already awarded are left alone — they record what a season's
board said at the time.

### Email sign-in is off in production

`POST /auth/magic-link` returns the verify token **in the response body**, and
nothing in this repo sends mail. On a real deployment that is not a way in for
the owner of an account, it is a way in for whoever asks first — for any address.
It is therefore refused unless the process is pointed at a non-production branch.
Google sign-in, which is what the site actually offers, is unaffected. If you
ever want email sign-in for real, add a mail sender first, then `ALLOW_MAGIC_LINK=1`.

Copy `.env.example` to `.env` for local Google sign-in. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application) and add Authorized JavaScript origins for `http://localhost:5173` and your production site. Use the same client ID in the frontend as `VITE_GOOGLE_CLIENT_ID`.

## Database scripts

| Script | Purpose |
|--------|---------|
| `npm run db:generate` | Generate SQL from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations in `drizzle/` |
| `npm run seed` | Force-seed sample boards/records/showcase trophies |
