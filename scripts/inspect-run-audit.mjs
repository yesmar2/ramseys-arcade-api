/**
 * Look into recent scores.
 *
 * The audit columns are only worth carrying if they can be read when a score
 * looks wrong, and a board never shows them. Usage:
 *
 *   node scripts/inspect-run-audit.mjs                 # 25 most recent, any game
 *   node scripts/inspect-run-audit.mjs snake 50        # one game, 50 rows
 *   node scripts/inspect-run-audit.mjs --name RAMSEY   # one player
 *
 * `rate` is points per second of measured run time — the number to sort by
 * when deciding whether a score is real, and the number to tune the caps in
 * src/scoreLimits.ts against once enough honest runs have accumulated.
 */

import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
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
    if (!process.env[key]) process.env[key] = value
  }
}

loadDotEnv()

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const args = process.argv.slice(2)
let game = null
let playerName = null
let limit = 25

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--name') {
    playerName = (args[++i] ?? '').toUpperCase()
  } else if (/^\d+$/.test(arg)) {
    limit = Math.min(500, Number(arg))
  } else {
    game = arg
  }
}

const sql = postgres(url, { max: 1, prepare: false })

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

function padLeft(value, width) {
  const text = String(value)
  return text.length >= width ? text.slice(0, width) : ' '.repeat(width - text.length) + text
}

try {
  const rows = await sql`
    SELECT game, name, score, at, device, run_id, duration_ms, ip_hash
    FROM leaderboard_scores
    WHERE (${game}::text IS NULL OR game = ${game})
      AND (${playerName}::text IS NULL OR name = ${playerName})
    ORDER BY at DESC
    LIMIT ${limit}
  `

  if (rows.length === 0) {
    console.log('no scores matched')
  } else {
    console.log(
      `${pad('WHEN', 20)}${pad('GAME', 12)}${pad('NAME', 13)}${padLeft('SCORE', 8)}  ${padLeft('SECS', 8)}  ${padLeft('RATE', 9)}  ${pad('DEVICE', 8)}${pad('RUN', 5)}IP`,
    )
    for (const row of rows) {
      const secs = row.duration_ms == null ? null : Number(row.duration_ms) / 1000
      const rate = secs && secs > 0 ? row.score / secs : null
      console.log(
        pad(new Date(Number(row.at)).toISOString().replace('T', ' ').slice(0, 19), 20) +
          pad(row.game, 12) +
          pad(row.name, 13) +
          padLeft(row.score, 8) +
          '  ' +
          padLeft(secs == null ? '-' : secs.toFixed(1), 8) +
          '  ' +
          padLeft(rate == null ? '-' : rate.toFixed(1), 9) +
          '  ' +
          pad(row.device, 8) +
          pad(row.run_id ? 'yes' : 'no', 5) +
          (row.ip_hash ?? '-').slice(0, 10),
      )
    }
  }

  const [summary] = await sql`
    SELECT count(*)::int AS total,
           count(run_id)::int AS with_run
    FROM leaderboard_scores
    WHERE (${game}::text IS NULL OR game = ${game})
  `
  console.log(
    `\n${summary.with_run} of ${summary.total} scores${game ? ` in ${game}` : ''} carry a run id`,
  )
} finally {
  await sql.end({ timeout: 5 })
}
