/**
 * Clear the Crosswalk boards whose numbers changed meaning.
 *
 * Crosswalk's score used to be the furthest row reached. It is points now — ten
 * a row, multiplied by the chain — because distance measured how long a player
 * was willing to sit still more than how well they crossed. Distance moved to
 * the `furthest-run` record book.
 *
 * That leaves two boards holding numbers that no longer mean what their column
 * says. This is not a fairness problem that time will fix, the way a tuning
 * change is; a row count and a point total are different units, and sorting
 * them against each other is meaningless in both directions.
 *
 *   leaderboard_scores (crosswalk)        rows, presented as points
 *   record_scores (threshold-streak)      runs over 200, labelled "over 2,000"
 *
 * Everything else stays. `most-coins` still counts coins, and the `fastest-row`
 * books still time a row milestone, so both still mean what they say.
 *
 *   node scripts/reset-crosswalk-scoring.mjs           # report only
 *   node scripts/reset-crosswalk-scoring.mjs --apply   # write a backup, then delete
 *
 * The backup is the full row, so the distances survive the clear. If those runs
 * are ever wanted back, they are already in the right unit for `furthest-run`.
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

const doApply = process.argv.slice(2).includes('--apply')
const sql = postgres(url, { max: 1, prepare: false })

function summarise(label, rows) {
  const seeded = rows.filter((r) => String(r.id).startsWith('seed-'))
  const real = rows.filter((r) => !String(r.id).startsWith('seed-'))
  const byName = new Map()
  for (const r of real) byName.set(r.name, (byName.get(r.name) ?? 0) + 1)
  console.log(`\n${label}`)
  console.log(`  total  ${rows.length}`)
  console.log(`  seeded ${seeded.length}`)
  console.log(`  real   ${real.length}`)
  if (byName.size) {
    const who = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} (${n})`)
      .join(', ')
    console.log(`  from   ${who}`)
  }
  if (real.length) {
    const scores = real.map((r) => r.score).sort((a, b) => b - a)
    console.log(`  best   ${scores.slice(0, 5).join(', ')}`)
  }
}

async function main() {
  const board = await sql`
    SELECT id, game, name, score, at, device
    FROM leaderboard_scores
    WHERE game = 'crosswalk'
    ORDER BY score DESC
  `
  const streak = await sql`
    SELECT id, game, record_id, name, score, at
    FROM record_scores
    WHERE game = 'crosswalk' AND record_id = 'threshold-streak'
    ORDER BY score DESC
  `

  summarise('leaderboard_scores (crosswalk) — rows, presented as points', board)
  summarise('record_scores (crosswalk/threshold-streak) — bar moved 200 to 2,000', streak)

  if (!doApply) {
    console.log('\nReport only. Re-run with --apply to back up and delete.')
    await sql.end()
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.resolve(process.cwd(), `crosswalk-scoring-reset-${stamp}.json`)
  fs.writeFileSync(
    backup,
    JSON.stringify({ takenAt: Date.now(), leaderboard: board, thresholdStreak: streak }, null, 2),
  )
  console.log(`\nBacked up ${board.length + streak.length} rows to ${backup}`)

  const boardIds = board.map((r) => r.id)
  const streakIds = streak.map((r) => r.id)
  let removedBoard = []
  let removedStreak = []
  if (boardIds.length) {
    removedBoard = await sql`
      DELETE FROM leaderboard_scores WHERE id IN ${sql(boardIds)} RETURNING id
    `
  }
  if (streakIds.length) {
    removedStreak = await sql`
      DELETE FROM record_scores WHERE id IN ${sql(streakIds)} RETURNING id
    `
  }
  console.log(`Deleted ${removedBoard.length} leaderboard rows`)
  console.log(`Deleted ${removedStreak.length} threshold-streak rows`)
  await sql.end()
}

main().catch(async (err) => {
  console.error(err)
  await sql.end()
  process.exit(1)
})
