import { and, asc, eq, gte } from 'drizzle-orm'
import { db } from './db/client.js'
import { gameRuns, runClaims } from './db/schema.js'
import { boardDateKey, boardDayStart, type GameSlug } from './store.js'

/*
 * Dailies whose day's result is the first run: Find the Bug, five scenes that are the same for everyone
 * all day. Once you know where the day's bugs hide, a second run is easy, so the board takes one run an
 * account a day, and only the first the account started that day. Replays are practice, which the site
 * never sends.
 *
 * A run opened while signed out belongs to whoever signs in and saves it (runs.ts), so the API can't tell
 * which of a signed-out player's runs came first; the site keeps that on the device. What it can tell, it
 * holds: a run opened signed in has to be the account's first of the day, and a signed-out one can't
 * have started after it.
 */
export const FIRST_RUN_DAILIES: ReadonlySet<GameSlug> = new Set<GameSlug>(['findbug'])

/**
 * How long the day's first run stays good: longer than any day, so it lasts until its day ends (after
 * that it's DAY_OVER), however long it was left paused in between.
 */
export const FIRST_RUN_TTL_MS = 25 * 60 * 60 * 1000

export type FirstRunCode = 'DAILY_DONE' | 'NOT_FIRST_RUN' | 'DAY_OVER'

export const FIRST_RUN_ERRORS: Record<FirstRunCode, string> = {
  DAILY_DONE: 'You’ve played today’s already: your first run is your result, and the rest are practice',
  NOT_FIRST_RUN: 'Only your first run of the day counts, and this wasn’t it',
  DAY_OVER: 'That run started on an earlier day’s scenes, so it can’t go on today’s board',
}

/** The claim that holds an account's day: one a game a day, in run_claims, where the insert is the lock. */
function dayClaim(accountId: string, game: GameSlug, now: number) {
  return { runId: `account:${accountId}`, surface: 'daily', ref: `${game}:${boardDateKey(now)}` }
}

/**
 * Why this save can't be the account's result today, or null when it can. Read only: nothing is held
 * until {@link claimFirstRunDay}, once everything else has had its say.
 */
export async function firstRunProblem(
  accountId: string,
  game: GameSlug,
  runId: string | null,
  now = Date.now(),
): Promise<FirstRunCode | null> {
  const claim = dayClaim(accountId, game, now)
  const [done] = await db()
    .select({ runId: runClaims.runId })
    .from(runClaims)
    .where(and(eq(runClaims.runId, claim.runId), eq(runClaims.surface, claim.surface), eq(runClaims.ref, claim.ref)))
    .limit(1)
  if (done) return 'DAILY_DONE'
  // Saved without a run (the API asleep when it began), the one a day is all there is to hold.
  if (!runId) return null

  const dayStart = boardDayStart(now)
  const [run] = await db()
    .select({ startedAt: gameRuns.startedAt })
    .from(gameRuns)
    .where(eq(gameRuns.id, runId))
    .limit(1)
  if (!run) return null
  if (run.startedAt < dayStart) return 'DAY_OVER'
  const [first] = await db()
    .select({ id: gameRuns.id, startedAt: gameRuns.startedAt })
    .from(gameRuns)
    .where(and(eq(gameRuns.accountId, accountId), eq(gameRuns.game, game), gte(gameRuns.startedAt, dayStart)))
    .orderBy(asc(gameRuns.startedAt), asc(gameRuns.id))
    .limit(1)
  if (first && first.id !== runId && first.startedAt <= run.startedAt) return 'NOT_FIRST_RUN'
  return null
}

/** Take the account's day for this game. False when a save got there first. */
export async function claimFirstRunDay(accountId: string, game: GameSlug, now = Date.now()): Promise<boolean> {
  const claimed = await db()
    .insert(runClaims)
    .values({ ...dayClaim(accountId, game, now), claimedAt: now })
    .onConflictDoNothing()
    .returning({ runId: runClaims.runId })
  return claimed.length > 0
}
