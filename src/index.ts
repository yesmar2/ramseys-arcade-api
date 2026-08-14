import cors from 'cors'
import express from 'express'
import { namesRouter } from './namesRoutes.js'
import { leaderboardsRouter } from './routes.js'
import { ALLOWED_GAMES } from './store.js'
import { tournamentsRouter } from './tournamentsRoutes.js'

const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '0.0.0.0'
const CORS_ORIGIN = process.env.CORS_ORIGIN

const app = express()

app.use(
  cors({
    // Reflect request origin in local/dev so phones on LAN work
    origin: CORS_ORIGIN
      ? CORS_ORIGIN.split(',').map((s) => s.trim())
      : true,
  }),
)
app.use(express.json({ limit: '32kb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, games: ALLOWED_GAMES })
})

app.use('/names', namesRouter)
app.use('/leaderboards', leaderboardsRouter)
app.use('/tournaments', tournamentsRouter)

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.listen(PORT, HOST, () => {
  console.log(`Ramsey's Arcade API listening on http://${HOST}:${PORT}`)
})
