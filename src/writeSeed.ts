import { seedGame, seedLeaderboards } from './seedBoards.js'
import { seedRecords } from './seedRecords.js'
import { ensureShowcaseTrophies } from './trophies.js'
import { isAllowedGame } from './store.js'
import { closeDb } from './db/client.js'
import { announceRewrite } from './feed.js'
import { runMigrations } from './db/migrate.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNotProduction } from './env.js'

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
// After the .env is read, so the branch it names is the one we check.
assertNotProduction('reseed the boards')
await runMigrations()

const game = process.argv[2]
try {
  if (game) {
    if (!isAllowedGame(game)) {
      console.error(`Unknown game: ${game}`)
      process.exitCode = 1
    } else {
      await seedGame(game)
      console.log(`Seeded ${game} leaderboard`)
    }
  } else {
    await seedLeaderboards(true)
    await seedRecords(true)
    await ensureShowcaseTrophies()
    console.log('Seeded sample boards + records + showcase trophies')
  }
  // API servers running as more than one read the boards again (feed.ts).
  await announceRewrite(['scores', 'records', 'site-records'], { force: true })
} finally {
  await closeDb()
}
