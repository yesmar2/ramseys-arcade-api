# Ramsey's Arcade API

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
