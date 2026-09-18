import { and, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, recordScores } from './db/schema.js'
import { getRecordDef } from './records.js'
import {
  boardDateKey,
  getBoardPage,
  inPeriod,
  previousBoardDateKey,
  type GameSlug,
  type Period,
} from './store.js'

/**
 * A player's own numbers, over time.
 *
 * The boards themselves stay free — they are the game, and hiding where a
 * score lands removes the reason to chase one. What this adds is the part a
 * board cannot show: how you got here, how you compare to everyone who ever
 * played, and which record is within reach.
 *
 * The headline counts are free; the rest is Plus. A locked page that shows
 * nothing sells nothing.
 */

export type StatsHeadline = {
  runs: number
  days: number
  games: number
  firstPlayedAt: number | null
}

export type StatsStreak = {
  current: number
  best: number
  /** Day keys played, newest first, for a calendar. */
  days: number[]
}

export type GameStat = {
  slug: string
  runs: number
  best: number
  /** Rank on the all-time board, 1-based. */
  rank: number | null
  totalPlayers: number
  /** Share of all runs on this game that your best beats, 0-100. */
  percentile: number
  average: number
  lastPlayedAt: number
  /** Your best per calendar day, oldest first — the shape of improvement. */
  trend: { at: number; score: number }[]
}

export type NearRecord = {
  game: string
  recordId: string
  label: string
  unit: 'ms' | 'count'
  direction: 'higher' | 'lower'
  yourBest: number
  leader: number
  leaderName: string
  /** Absolute distance to the leader, in the record's own unit. */
  gap: number
  /** How close you are, 0-100. Higher is closer. */
  closeness: number
}

export type PlayerStats = {
  headline: StatsHeadline
  streak: StatsStreak
  games: GameStat[]
  nearRecords: NearRecord[]
}

/** Consecutive days ending today (or yesterday) that have a run in them. */
function streakFrom(dayKeys: number[], now: number): StatsStreak {
  const days = [...new Set(dayKeys)].sort((a, b) => b - a)
  const have = new Set(days)

  let current = 0
  // A streak survives until the day after the last one is over, so start the
  // walk at today and fall back to yesterday before giving up.
  let cursor = boardDateKey(now)
  if (!have.has(cursor)) cursor = previousBoardDateKey(cursor)
  while (have.has(cursor)) {
    current += 1
    cursor = previousBoardDateKey(cursor)
  }

  let best = 0
  let run = 0
  let prev: number | null = null
  for (const day of [...days].reverse()) {
    run = prev != null && previousBoardDateKey(day) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }

  return { current, best, days }
}

/** Best run per calendar day, oldest first — a trend, not every attempt. */
function trendOf(rows: { at: number; score: number }[]): { at: number; score: number }[] {
  const byDay = new Map<number, { at: number; score: number }>()
  for (const row of rows) {
    const key = boardDateKey(row.at)
    const have = byDay.get(key)
    if (!have || row.score > have.score) byDay.set(key, row)
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row)
    .slice(-30)
}

export async function playerStats(
  rawName: string,
  period: Period = 'all',
  now = Date.now(),
): Promise<PlayerStats> {
  const name = rawName.trim().slice(0, 12).toUpperCase()
  const empty: PlayerStats = {
    headline: { runs: 0, days: 0, games: 0, firstPlayedAt: null },
    streak: { current: 0, best: 0, days: [] },
    games: [],
    nearRecords: [],
  }
  if (!name) return empty

  const all = await db()
    .select({
      game: leaderboardScores.game,
      score: leaderboardScores.score,
      at: leaderboardScores.at,
    })
    .from(leaderboardScores)
    .where(eq(leaderboardScores.name, name))
  if (all.length === 0) return empty
  // Same window the boards use, so "this week" means one thing in this app.
  const mine = all.filter((row) => inPeriod(row.at, period, now))
  // The streak outlives the window: a quiet Tuesday does not end a habit.
  const lifetimeStreak = streakFrom(
    all.map((r) => boardDateKey(r.at)),
    now,
  )
  if (mine.length === 0) return { ...empty, streak: lifetimeStreak }

  const byGame = new Map<string, { score: number; at: number }[]>()
  for (const row of mine) {
    const list = byGame.get(row.game) ?? []
    list.push({ score: row.score, at: row.at })
    byGame.set(row.game, list)
  }

  /*
   * Percentile and rank both need the whole board, but only as aggregates —
   * one grouped query per game beats pulling every row down to count them here.
   */
  const games: GameStat[] = []
  for (const [slug, rows] of byGame) {
    const best = Math.max(...rows.map((r) => r.score))
    const total = rows.reduce((sum, r) => sum + r.score, 0)

    /*
     * Measured against the same board the player would be looking at, which
     * is the cached one — it already knows how to cut a period, and asking it
     * beats a second set of SQL that has to agree with it.
     */
    const board = await getBoardPage(slug as GameSlug, period, {
      limit: Number.MAX_SAFE_INTEGER,
      now,
    })
    const names = new Set<string>()
    let beaten = 0
    const ahead = new Set<string>()
    for (const entry of board.entries) {
      names.add(entry.name)
      if (entry.score < best) beaten += 1
      if (entry.score > best) ahead.add(entry.name)
    }

    const boardRuns = board.total || rows.length
    games.push({
      slug,
      runs: rows.length,
      best,
      rank: ahead.size + 1,
      totalPlayers: names.size || 1,
      percentile: boardRuns > 0 ? Math.round((beaten / boardRuns) * 100) : 0,
      average: Math.round(total / rows.length),
      lastPlayedAt: Math.max(...rows.map((r) => r.at)),
      trend: trendOf(rows),
    })
  }
  games.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)

  return {
    headline: {
      runs: mine.length,
      days: new Set(mine.map((r) => boardDateKey(r.at))).size,
      games: byGame.size,
      firstPlayedAt: Math.min(...mine.map((r) => r.at)),
    },
    streak: lifetimeStreak,
    games,
    nearRecords: await nearRecords(name),
  }
}

/**
 * Record boards you are on but not top of, closest first.
 *
 * The most useful thing on the page: every row is a specific run that would
 * change something, rather than a number to admire.
 */
async function nearRecords(name: string, limit = 6): Promise<NearRecord[]> {
  const mine = await db()
    .select({
      game: recordScores.game,
      recordId: recordScores.recordId,
      score: recordScores.score,
    })
    .from(recordScores)
    .where(eq(recordScores.name, name))
  if (mine.length === 0) return []

  const bestOf = new Map<string, { game: string; recordId: string; score: number }>()
  for (const row of mine) {
    const def = getRecordDef(row.game, row.recordId)
    if (!def) continue
    const key = `${row.game}::${row.recordId}`
    const have = bestOf.get(key)
    const better =
      !have || (def.direction === 'lower' ? row.score < have.score : row.score > have.score)
    if (better) bestOf.set(key, row)
  }

  const out: NearRecord[] = []
  for (const [, row] of bestOf) {
    const def = getRecordDef(row.game, row.recordId)
    if (!def) continue
    const [leader] = await db()
      .select({ name: recordScores.name, score: recordScores.score })
      .from(recordScores)
      .where(
        and(eq(recordScores.game, row.game), eq(recordScores.recordId, row.recordId)),
      )
      .orderBy(
        def.direction === 'lower'
          ? sql`${recordScores.score} asc`
          : sql`${recordScores.score} desc`,
      )
      .limit(1)
    if (!leader) continue
    // Already holding it is not something to chase.
    if (leader.name === name) continue

    const gap = Math.abs(leader.score - row.score)
    const scale = Math.max(Math.abs(leader.score), 1)
    out.push({
      game: row.game,
      recordId: row.recordId,
      label: def.label,
      unit: def.unit,
      direction: def.direction,
      yourBest: row.score,
      leader: leader.score,
      leaderName: leader.name,
      gap,
      closeness: Math.max(0, Math.round((1 - gap / scale) * 100)),
    })
  }

  return out.sort((a, b) => b.closeness - a.closeness).slice(0, limit)
}
