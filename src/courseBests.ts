import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { inArchive } from './archive.js'
import { accountFromRequest } from './auth.js'
import { db } from './db/client.js'
import { courseBests } from './db/schema.js'
import { takeToken } from './rateLimit.js'
import { peekRun } from './runs.js'
import { getClaim } from './names.js'
import { checkScoreRate, TIME_SCORE_BASE } from './scoreLimits.js'
import { resolveGameSlug, type GameSlug } from './store.js'
import { RACE_MEDAL_RUNGS, RACE_MEDAL_STEP } from './ticketLadders.js'
import { coursePace, fastestBelievable, TRACK_GAMES, trackDayIso, trackState } from './trackLaps.js'

/*
 * Your best time on every course of a racing daily, for your medals on its past courses (Ramsey picked A and C of
 * the "Medal collection" canvas, 2026-10-09: a medal shelf over the past tracks, and the next medal on each
 * card). Every finished run on a course sends its time, on the course's day, in the week after, or as a Plus
 * member's practice on an older one, and the quickest is kept. It's yours alone: no board, place, rank or
 * ticket reads it, so a Plus member bettering an old course's medal buys nobody a place anywhere.
 *
 * The times stay yours, but how many medals they add up to is anyone's to see: the player card shows it (Ramsey
 * made the counts public, 2026-10-20, for the card's "Race medals").
 *
 *   GET  /course-bests/medals?name=TAG   a player's medals, counted: { platinum, gold, silver, bronze }
 *   GET  /course-bests/:game        your best on each of the game's courses: [{ course, ms }]
 *   POST /course-bests/:game/:n     a finished run's time on course n: { ms, runId }, kept if it's your best
 */
export const courseBestsRouter = Router()

/** A run ends a minute at the quickest: this is a busy player's every run with plenty to spare. */
const BEST_LIMIT = { limit: 60, windowMs: 10 * 60 * 1000 }

const bestSchema = z.object({
  ms: z.number().int().positive().max(TIME_SCORE_BASE - 1),
  runId: z.string().min(1).max(64),
  /** How long after the run began its id came back, as the site measured it (runs.ts runLag). */
  runLagMs: z.number().int().min(0).max(3_600_000).optional(),
})

function courseGame(raw: string): GameSlug | null {
  const game = resolveGameSlug(raw)
  return game && TRACK_GAMES.has(game) ? game : null
}

/** Keep a run's time on a course if it's the account's best there. Whether it was. */
export async function keepCourseBest(accountId: string, game: GameSlug, course: number, ms: number, now = Date.now()): Promise<boolean> {
  const kept = await db()
    .insert(courseBests)
    .values({ accountId, game, course, ms, at: now })
    .onConflictDoUpdate({
      target: [courseBests.accountId, courseBests.game, courseBests.course],
      set: { ms, at: now },
      where: sql`${courseBests.ms} > ${ms}`,
    })
    .returning({ ms: courseBests.ms })
  return kept.length > 0
}

/** An account's best on each of a game's courses. */
export async function courseBestsOf(accountId: string, game: GameSlug): Promise<{ course: number; ms: number }[]> {
  return db()
    .select({ course: courseBests.course, ms: courseBests.ms })
    .from(courseBests)
    .where(and(eq(courseBests.accountId, accountId), eq(courseBests.game, game)))
}

export type MedalCounts = { platinum: number; gold: number; silver: number; bronze: number }

const MEDAL_ORDER = ['bronze', 'silver', 'gold', 'platinum'] as const

/**
 * How many of each medal an account's course bests take, each course's best against its blue run (the site's
 * raceMedals.ts medalFor, with ticketLadders.ts's rungs and steps).
 */
export async function medalCountsOf(accountId: string, window: readonly [number, number] | null = null): Promise<MedalCounts> {
  // With a window (a season's, for its sticker page), only the bests set in it.
  const rows = await db()
    .select({ game: courseBests.game, course: courseBests.course, ms: courseBests.ms })
    .from(courseBests)
    .where(
      window
        ? and(eq(courseBests.accountId, accountId), gte(courseBests.at, window[0]), lt(courseBests.at, window[1]))
        : eq(courseBests.accountId, accountId),
    )
  const counts: MedalCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0 }
  for (const row of rows) {
    const step = RACE_MEDAL_STEP[row.game as keyof typeof RACE_MEDAL_STEP]
    const pace = coursePace(row.game as GameSlug, row.course)
    if (!step || !pace) continue
    // The highest rung the time beats, if any.
    let best = -1
    for (let i = 0; i < MEDAL_ORDER.length; i++) if (row.ms <= Math.round(pace * (1 - RACE_MEDAL_RUNGS[i]! * step))) best = i
    if (best >= 0) counts[MEDAL_ORDER[best]!] += 1
  }
  return counts
}

courseBestsRouter.get('/medals', async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  const claim = name ? await getClaim(name) : null
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const none: MedalCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0 }
  res.json({ medals: claim?.accountId ? await medalCountsOf(claim.accountId) : none })
})

courseBestsRouter.get('/:game', async (req, res) => {
  const game = courseGame(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'No such game' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in for your medals', code: 'AUTH_REQUIRED' })
    return
  }
  res.json({ bests: await courseBestsOf(account.id, game) })
})

courseBestsRouter.post('/:game/:n', async (req, res) => {
  const game = courseGame(req.params.game)
  const n = Number(req.params.n)
  const state = game ? trackState(n, Date.now(), game) : 'none'
  if (!game || state === 'none') {
    res.status(404).json({ error: 'No such course' })
    return
  }
  // A course still to come is a test run, kept nowhere.
  if (state === 'ahead') {
    res.status(409).json({ error: 'This course’s day hasn’t come yet', code: 'TRACK_AHEAD' })
    return
  }
  const parsed = bestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const { ms, runId, runLagMs } = parsed.data
  if (ms < fastestBelievable(n, game)) {
    res.status(400).json({ error: 'That time is not possible on this course', code: 'SCORE_OUT_OF_RANGE' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep your medals', code: 'AUTH_REQUIRED' })
    return
  }
  // A course over a week old is Plus's to play (archive.ts): only a member's practice on one is kept.
  if (state === 'past' && inArchive(trackDayIso(n, game)) && account.plan !== 'plus') {
    res.status(403).json({ error: 'Courses over a week old are raced with Plus', code: 'ARCHIVED' })
    return
  }
  const gate = takeToken(`best:account:${account.id}`, BEST_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many runs too quickly', code: 'RATE_LIMITED' })
    return
  }
  // Timed by the server as a board's run is: it can't have taken less time than it claims.
  const run = await peekRun(runId, account.id, game, undefined, runLagMs)
  if (!run.ok) {
    res.status(400).json({ error: 'That run is not on record', code: `RUN_${run.code}` })
    return
  }
  const plausible = checkScoreRate(game, TIME_SCORE_BASE - ms, run.checkedMs)
  if (!plausible.ok) {
    console.warn(`[anticheat] rejected a ${game} course ${n} best of ${ms}ms from account ${account.id} after ${run.checkedMs}ms: ${plausible.reason}`)
    res.status(400).json({ error: 'That time is not possible in the time the run took', code: 'SCORE_IMPLAUSIBLE' })
    return
  }
  const improved = await keepCourseBest(account.id, game, n, ms)
  res.status(improved ? 201 : 200).json({ improved })
})
