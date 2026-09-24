import { applyDataRepairs } from './repairs.js'
import cors from 'cors'
import { logDbTarget } from './env.js'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authRouter } from './authRoutes.js'
import { namesRouter } from './namesRoutes.js'
import { leaderboardsRouter } from './routes.js'
import { runsRouter } from './runsRoutes.js'
import { adminRouter } from './adminRoutes.js'
import { recordsRouter } from './recordsRoutes.js'
import { seedLeaderboards } from './seedBoards.js'
import { seedRecords } from './seedRecords.js'
import { ALLOWED_GAMES } from './store.js'
import { applySeedRevision } from './seedRevision.js'
import { friendsRouter } from './friendsRoutes.js'
import { groupsRouter } from './groupsRoutes.js'
import { invitesRouter } from './invitesRoutes.js'
import { tournamentsRouter } from './tournamentsRoutes.js'
import { notificationsRouter } from './notificationsRoutes.js'
import { challengesRouter } from './challengesRoutes.js'
import { publicVapidKey } from './push.js'
import { statsRouter } from './statsRoutes.js'
import { trophiesRouter } from './trophiesRoutes.js'
import { checkDbHealth, queryStats } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { migrateStrideToCrosswalk } from './migrateStrideToCrosswalk.js'
import { lastSweptAt, startSweeping } from './sweep.js'

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

async function main() {
  await runMigrations()
  await migrateStrideToCrosswalk()

  const app = express()

  /*
   * Render terminates TLS one hop in front of this process, so without this
   * every request reports the proxy's address and an address-keyed rate limit
   * would throttle the whole site as one caller. One hop only — trusting the
   * whole chain would let a client name its own address in X-Forwarded-For.
   */
  app.set('trust proxy', 1)

  app.use(
    cors({
      origin: CORS_ORIGIN
        ? CORS_ORIGIN.split(',').map((s) => s.trim())
        : true,
    }),
  )
  app.use(express.json({ limit: '32kb' }))

  // Every response says what it cost: wall time and database round trips.
  // The database is a network hop away, so the round-trip count is the number
  // that matters when something feels slow. LOG_REQUESTS=1 prints it too.
  app.use((req, res, next) => {
    const started = performance.now()
    queryStats.run({ queries: 0 }, () => {
      const stats = queryStats.getStore()
      const writeHead = res.writeHead.bind(res)
      res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
        res.setHeader('X-Elapsed-Ms', String(Math.round(performance.now() - started)))
        res.setHeader('X-Db-Queries', String(stats?.queries ?? 0))
        return writeHead(...args)
      }) as typeof res.writeHead
      res.on('finish', () => {
        if (process.env.LOG_REQUESTS === '1') {
          const ms = Math.round(performance.now() - started)
          console.log(
            `${req.method} ${req.originalUrl.slice(0, 90)} ${res.statusCode} ${ms}ms ${stats?.queries ?? 0}q`,
          )
        }
      })
      next()
    })
  })

  app.get('/health', async (_req, res) => {
    const dbHealth = await checkDbHealth()
    res.status(dbHealth.ok ? 200 : 503).json({
      ok: dbHealth.ok,
      games: ALLOWED_GAMES,
      db: dbHealth.ok,
      // Whether VAPID is configured here. Without it the opt-in is hidden in
      // the app, which is otherwise indistinguishable from the feature missing.
      push: Boolean(publicVapidKey()),
      // When match alerts, results and held pushes were last seen to; null until the first sweep.
      sweptAt: lastSweptAt(),
      ...(dbHealth.error ? { error: dbHealth.error } : {}),
    })
  })

  app.use('/auth', authRouter)
  app.use('/names', namesRouter)
  app.use('/leaderboards', leaderboardsRouter)
  app.use('/runs', runsRouter)
  app.use('/admin', adminRouter)
  app.use('/records', recordsRouter)
  app.use('/tournaments', tournamentsRouter)
  app.use('/groups', groupsRouter)
  app.use('/invites', invitesRouter)
  app.use('/friends', friendsRouter)
  app.use('/trophies', trophiesRouter)
  app.use('/notifications', notificationsRouter)
  app.use('/challenges', challengesRouter)
  app.use('/stats', statsRouter)

  logDbTarget()

  const forceSeed = process.env.SEED_FORCE === '1' || process.env.SEED_FORCE === 'true'
  const sampleSeed =
    process.env.SEED_SAMPLE === '1' || process.env.SEED_SAMPLE === 'true'
  if (await applySeedRevision(forceSeed)) {
    console.log('Cleared leaderboards + records (revision bump or SEED_FORCE)')
  } else if (sampleSeed) {
    if (await seedLeaderboards(false)) {
      console.log('Seeded leaderboards with sample arcade scores')
    }
    if (await seedRecords(false)) {
      console.log('Seeded record books with sample times')
    }
  }

  try {
    await applyDataRepairs()
  } catch (err) {
    console.error('[repair] failed', err)
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  app.listen(PORT, HOST, () => {
    console.log(`Skermix API listening on http://${HOST}:${PORT}`)
  })
  startSweeping()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
