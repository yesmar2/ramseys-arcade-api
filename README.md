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

### More than one instance

Each instance keeps the boards, record books, events, tags and sessions in memory, so by default the API must run as **one** instance. To run more on Render (any paid instance type; the service must have no disk):

1. On the service's **Environment** page, add `MULTI_INSTANCE` = `1`, and save it so it deploys, still at one instance. Don't add it to render.yaml: an edit there puts its env values back over the dashboard's (render.yaml's `value:` lines).
2. Check that `/health` answers `"db": true`, and that the next save and log-in work.
3. On the service's **Compute** page, under **Manual Scaling**, set the instance count (2, then more as needed) and **Save Changes**. Render starts the new instances at once and shares requests evenly between them. Each instance is billed as a whole plan: two Pro instances cost twice one.
4. Autoscaling (a minimum, a maximum and a target CPU or memory) needs a Pro *workspace* plan or higher. It scales up at once and down a few minutes later, and it overrides the manual count.

Before you need it:
- `DATABASE_URL` should be Neon's **pooled** connection string (its host has `-pooler`), as each instance opens up to 10 connections (`src/db/client.ts`).
- Set `NODE_OPTIONS` = `--max-old-space-size=3072` on a 4 GB instance. Every instance holds the whole score history: about 2.5 GB at 20,000 players and 2.3 million runs (scripts/loadtest). More instances spread the requests, not that memory, and every instance still takes in every save.

Checked 2026-10-20 on two local servers with `MULTI_INSTANCE=1`, on a 20,000-player world:
- `scripts/loadtest/multi-check.mjs` passed all its checks. A change made on one server was on the other at once: a save, a record, a log-out, an avatar, a group, a capped event and a bracket joined from both, a Plus grant, a deleted account and a lap on a past course.
- 550 people spread over both (`site.mjs --bases`) ran at 413 req/s, p50 21 ms, p95 0.42 s. The two then gave the same answers: `days-check.mjs` 4,971 of 4,971 and `compare.mjs` 400 of 400.
- A server restarted afterwards, reading the tables afresh, gave those same answers too.

With it on, every change goes into the `change_feed` table and every instance reads it twice a second (`src/feed.ts`); a response to a change carries `X-Feed-Id`, and the app sends it back as `X-Feed-After` for 15 seconds, so whichever instance answers next has read that far first. The sweep runs on one instance at a time (a lease in the `leases` table), and so do the checks at boot. Things to know:

- The feed polls the database twice a second per instance, so Neon never idles down while the API runs.
- Rate limits are counted per instance, so a caller spread across two instances gets twice the allowance.
- A script that rewrites tables (`npm run seed:world`, `npm run seed`, `avatars:refresh`) tells running instances through the feed; anything else that writes to the tables directly needs a restart of the API. With one instance the ten-minute look at the tables still catches it.
- A few things are kept per instance for up to a minute and reach the others when that runs out: a day's Ace Chase spread (20 s), bug-hunt and poll counts (20 s and 15 s), friend lists (10 s), name flair (60 s), the site events switch (30 s) and the season preview switch (30 s).
- The admin page's **Reset test data** restarts every instance, a few seconds apart, as it restarts the one that ran it.
- Going back to one instance: lower the count first, then remove the variable.

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
| `MULTI_INSTANCE` | Set to `1` before running more than one instance. See below |

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
| `GET /admin/client-errors?limit=` | What broke in players' browsers, the latest first |
| `DELETE /admin/client-errors/:fingerprint` | One error off the list; it comes back if it happens again |
| `POST /admin/client-errors/clear` `{before}` | Every error last seen by `before`, the newest the list showed |
| `GET /admin/feedback?limit=` | What players sent from Tell us, the latest first |
| `DELETE /admin/feedback/:id` | One message off the list, for good |
| `POST /admin/feedback/clear` `{before}` | Every message sent by `before`, the newest the list showed |

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
