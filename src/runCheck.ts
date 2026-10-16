import { and, gte, notLike, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'
import { RUNS_REQUIRED } from './runs.js'

/*
 * Before REQUIRE_RUN_TOKEN goes on, every save the site makes should already be carrying its run: one that
 * doesn't would be refused once it's on. This says how many of the last days' saves did, game by game, for
 * the admin page, so the switch can be thrown on what the live boards show rather than on a guess. Seeded
 * rows (ids seed-*) are left out: the seeded world never ran anything.
 */

export type RunCheckGame = {
  game: string
  saves: number
  withRun: number
  /** When the latest save without a run came in, if one did. */
  lastWithout: number | null
}

export type RunCheck = {
  /** Whether runs are required now. */
  required: boolean
  days: number
  saves: number
  withRun: number
  games: RunCheckGame[]
}

export async function runCheck(days: number, now = Date.now()): Promise<RunCheck> {
  const since = now - days * 86_400_000
  const rows = await db()
    .select({
      game: leaderboardScores.game,
      saves: sql<number>`count(*)::int`,
      withRun: sql<number>`count(${leaderboardScores.runId})::int`,
      lastWithout: sql<string | null>`max(case when ${leaderboardScores.runId} is null then ${leaderboardScores.at} end)`,
    })
    .from(leaderboardScores)
    .where(and(gte(leaderboardScores.at, since), notLike(leaderboardScores.id, 'seed-%')))
    .groupBy(leaderboardScores.game)
  const games = rows
    .map((r) => ({ game: r.game, saves: r.saves, withRun: r.withRun, lastWithout: r.lastWithout == null ? null : Number(r.lastWithout) }))
    // The games with saves missing their run first, the most missing first.
    .sort((a, b) => b.saves - b.withRun - (a.saves - a.withRun) || b.saves - a.saves)
  return {
    required: RUNS_REQUIRED,
    days,
    saves: games.reduce((n, g) => n + g.saves, 0),
    withRun: games.reduce((n, g) => n + g.withRun, 0),
    games,
  }
}
