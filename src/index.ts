import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRouter } from './authRoutes.js'
import { namesRouter } from './namesRoutes.js'
import { leaderboardsRouter } from './routes.js'
import { recordsRouter } from './recordsRoutes.js'
import { seedLeaderboards } from './seedBoards.js'
import { seedRecords } from './seedRecords.js'
import { ALLOWED_GAMES } from './store.js'
import { tournamentsRouter } from './tournamentsRoutes.js'
import { trophiesRouter } from './trophiesRoutes.js'

/** Load .env into process.env when present (does not override existing vars). */
function loadDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'),
  ]
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (process.env[key] == null || process.env[key] === '') {
          process.env[key] = value
        }
      }
      return
    } catch {
      /* try next */
    }
  }
}

loadDotEnv()

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

app.use('/auth', authRouter)
app.use('/names', namesRouter)
app.use('/leaderboards', leaderboardsRouter)
app.use('/records', recordsRouter)
app.use('/tournaments', tournamentsRouter)
app.use('/trophies', trophiesRouter)

const forceSeed = process.env.SEED_FORCE === '1' || process.env.SEED_FORCE === 'true'
if (seedLeaderboards(forceSeed)) {
  console.log('Seeded leaderboards with sample arcade scores')
}
if (seedRecords(forceSeed)) {
  console.log('Seeded record books with sample times')
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.listen(PORT, HOST, () => {
  console.log(`Fordriva API listening on http://${HOST}:${PORT}`)
})
