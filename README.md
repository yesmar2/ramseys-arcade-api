# Fordriva API

Leaderboard + tournament backend for [ramseys-arcade](https://github.com/yesmar2/ramseys-arcade).

## Local

```bash
npm install
npm run dev
```

Listens on `http://localhost:8787` (`PORT` / `HOST` env supported).

## Deploy (Render)

This repo includes `render.yaml`. From the [Render dashboard](https://dashboard.render.com/blueprints/new):

1. Connect the `yesmar2/ramseys-arcade-api` GitHub repo
2. Apply the Blueprint (free web service)
3. After the Vercel frontend is live, set `CORS_ORIGIN` to that origin (e.g. `https://ramseys-arcade.vercel.app`)

Health check: `GET /health`

**Note:** Score/tournament JSON lives on the instance disk. Free-tier redeploys can reset data; a persistent disk can be added later.

## Env

| Variable | Description |
|----------|-------------|
| `PORT` | Listen port (Render sets this) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `CORS_ORIGIN` | Comma-separated allowed origins. If unset, reflects any origin (fine for first bring-up) |
| `GOOGLE_CLIENT_ID` | Google OAuth Web client ID for Sign in with Google (`POST /auth/google`) |
| `FRONTEND_ORIGIN` | Used when minting magic-link URLs (default `http://localhost:5173`) |

Copy `.env.example` to `.env` for local Google sign-in. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application) and add Authorized JavaScript origins for `http://localhost:5173` and your production site. Use the same client ID in the frontend as `VITE_GOOGLE_CLIENT_ID`.
