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

Copy `.env.example` to `.env` for local Google sign-in. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application) and add Authorized JavaScript origins for `http://localhost:5173` and your production site. Use the same client ID in the frontend as `VITE_GOOGLE_CLIENT_ID`.

## Database scripts

| Script | Purpose |
|--------|---------|
| `npm run db:generate` | Generate SQL from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations in `drizzle/` |
| `npm run seed` | Force-seed sample boards/records/showcase trophies |
