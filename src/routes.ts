import { checkScoreRate, scoreCeiling, TIME_SCORE_BASE } from './scoreLimits.js'
import { Router } from 'express'
import { z } from 'zod'
import { pageParams } from './paging.js'
import { accountFromRequest } from './auth.js'
import { clientOffset, secretsForRun } from './secrets.js'
import { settleToday } from './today.js'
import { tellBeatenFriends } from './todayBeaten.js'
import { isBanned } from './bans.js'
import { clientIp, hashIp, takeToken } from './rateLimit.js'
import { claimRun, peekRun } from './runs.js'
import { claimFirstRunDay, FIRST_RUN_DAILIES, FIRST_RUN_TTL_MS, firstRunError, firstRunProblem } from './firstRun.js'
import { judgePours, minPourMs, poursSchema } from './halffull/save.js'
import { flagIfSuspicious } from './scoreFlags.js'
import { resolveBoardScope } from './groups.js'
import { assertCanUseName, withAvatarId, withAvatarIds } from './names.js'
import { updateCrossRunStreakRecords } from './records.js'
import { noteDayRun } from './courseRecords.js'
import { dailyFirstDay, dailyRecords, dayResultKeep, standingOn, type DailyTally } from './dailyRecords.js'
import { recordChallengeRun } from './challenges.js'
import { payRun, plausiblePickups, type RunTickets } from './tickets.js'
import { landerPlannedPace, marblerunPlannedPace } from './ticketLadders.js'
import {
  addScore,
  ALLOWED_GAMES,
  bestForName,
  bestsForName,
  boardDateKey,
  boardsSummaryForPeriod,
  DAILY_GAMES,
  DAILY_SINCE,
  dailyDays,
  dayBoardPage,
  getBoard,
  getBoardPage,
  globalRanksPage,
  isPeriod,
  isRankedGame,
  qualifies,
  qualifiesAny,
  rankForName,
  rankForScore,
  ranksForScore,
  resolveGameSlug,
  type GameSlug,
  type Period,
} from './store.js'

export const leaderboardsRouter = Router()

leaderboardsRouter.get('/bests', async (req, res) => {
  const name = String(req.query.name ?? '').trim()
  if (!name) {
    res.status(400).json({ error: 'name query param required' })
    return
  }
  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }
  const period: Period = isPeriod(periodParam) ? periodParam : 'all'
  const cleaned = name.slice(0, 12).toUpperCase()
  // Same scope every other board honours: inside a group, your best is your
  // best among that roster — and nothing at all if you are not on it.
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  res.json({
    name: cleaned,
    period,
    bests: await bestsForName(name, period, Date.now(), scope),
    avatarId: (await withAvatarId({ name: cleaned })).avatarId,
  })
})

leaderboardsRouter.get('/rank', async (req, res) => {
  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }
  const period: Period = isPeriod(periodParam) ? periodParam : 'all'

  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
  if (name) {
    const data = await rankForName(name, 2, period, Date.now(), scope)
    // One avatar lookup for the player and their neighbours together.
    const [me, nearby] = await Promise.all([
      withAvatarId({ name: name.slice(0, 12).toUpperCase() }),
      withAvatarIds(data.nearby),
    ])
    res.json({
      ...data,
      period,
      avatarId: me.avatarId,
      nearby,
    })
    return
  }
  const { limit, offset } = pageParams(req.query, 50)
  const page = await globalRanksPage(period, offset, limit, Date.now(), scope)
  res.json({
    period,
    offset,
    totalPlayers: page.total,
    entries: await withAvatarIds(page.entries),
  })
})

leaderboardsRouter.get('/summary', async (req, res) => {
  const limitRaw = Number(req.query.limit ?? 3)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(10, Math.max(1, Math.floor(limitRaw)))
    : 3
  const period = parsePeriod(req.query.period)
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const boards = await boardsSummaryForPeriod(period, limit, Date.now(), scope)
  const games = await Promise.all(
    ALLOWED_GAMES.map(async (slug) => ({
      slug,
      entries: await withAvatarIds(boards[slug]),
    })),
  )
  res.json({ limit, period, games })
})

/** A board day key (YYYYMMDD) as the day it is, YYYY-MM-DD. */
const dayOfKey = (key: number) => `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`

const submitSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().positive().max(1_000_000),
  token: z.string().min(1).max(128).optional(),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
  /** Optional until REQUIRE_RUN_TOKEN — older clients do not send one. */
  runId: z.string().min(1).max(64).optional(),
  /** The challenge this run was played against, from a friend's link. */
  challengeId: z.string().min(1).max(16).optional(),
  /** Prize tickets the run picked up on the way (Crosswalk's), paid on top of the run's own. */
  pickups: z.number().int().min(0).max(500).optional(),
  /** Hot Lap: the day's blue car, in milliseconds, which its ticket ladder goes by. */
  pace: z.number().int().min(10_000).max(300_000).optional(),
  /** Half Full: the day and its five locked levels, from which the API works out the score itself. */
  pours: poursSchema.optional(),
})

/*
 * Nobody finishes more than a handful of runs in ten minutes, so this only
 * ever bites a script. It sits after the auth check so the key is an account
 * rather than an address, which a phone on mobile data changes constantly.
 */
const SUBMIT_LIMIT = { limit: 40, windowMs: 10 * 60 * 1000 }

const REQUIRE_RUN_TOKEN =
  process.env.REQUIRE_RUN_TOKEN === '1' || process.env.REQUIRE_RUN_TOKEN === 'true'

const RUN_ERRORS: Record<'UNKNOWN' | 'USED' | 'EXPIRED' | 'MISMATCH', string> = {
  UNKNOWN: 'That run is not on record',
  USED: 'That run already saved a score',
  EXPIRED: 'That run is too old to save',
  MISMATCH: 'That run belongs to a different game',
}

function parsePeriod(raw: unknown): Period {
  if (isPeriod(raw)) return raw
  return 'all'
}

async function boardAccess(req: import('express').Request) {
  const account = await accountFromRequest(req)
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const groupId = typeof req.query.group === 'string' ? req.query.group : undefined
  return resolveBoardScope(groupId, { accountId: account?.id, playerName })
}

function scopeError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

/** A `day` query's YYYY-MM-DD, if it's a real date, as its board day key (YYYYMMDD); null if it isn't one. */
function dayKeyOfParam(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return y * 10_000 + m * 100 + d
}

/**
 * One day's board of a daily game (`?period=daily&day=YYYY-MM-DD`): a past day's final board, in full a
 * page at a time, or today's so far. One row a player, their best run that day (Find the Bug's, Half
 * Full's and Ace Chase's only run: they take one result a day), ranked as the day's board was when it
 * paid its day points (store.ts dayBoardPage). `counted` is false before the game's days counted
 * (DAILY_SINCE: Ace Chase's holes #1 and #2), `final` true once the day is over. `total` is the day's
 * players, and `you` is `name`'s place among them, not a run's rank. In a group, the day ranks its members.
 */
async function dayBoard(req: import('express').Request, res: import('express').Response, game: GameSlug) {
  if (!DAILY_GAMES.has(game)) {
    res.status(404).json({ error: 'Not a daily game', code: 'NOT_DAILY' })
    return
  }
  // A daily just for fun keeps no board of its days (store.ts UNRANKED_GAMES).
  if (!isRankedGame(game)) {
    res.status(404).json({ error: 'This daily is just for fun: it has no boards', code: 'NOT_RANKED' })
    return
  }
  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && periodParam !== 'daily') {
    res.status(400).json({ error: 'A day’s board is period=daily', code: 'BAD_PERIOD' })
    return
  }
  const key = dayKeyOfParam(req.query.day)
  if (key == null) {
    res.status(400).json({ error: 'A day is a date, YYYY-MM-DD', code: 'BAD_DAY' })
    return
  }
  const today = boardDateKey(Date.now())
  if (key > today) {
    res.status(404).json({ error: 'That day hasn’t come yet', code: 'DAY_AHEAD', today: dayOfKey(today) })
    return
  }
  const first = dailyFirstDay(game)
  if (key < first) {
    res.status(404).json({ error: `No board that day: this game’s days began on ${dayOfKey(first)}`, code: 'BEFORE_FIRST_DAY', firstDay: dayOfKey(first) })
    return
  }
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const name = typeof req.query.name === 'string' ? req.query.name : null
  const { limit, offset } = pageParams(req.query)
  const page = await dayBoardPage(game, key, { offset, limit, scope, name, keep: dayResultKeep(game) })
  const final = key < today
  // A day that's over stays as it closed. Not a group's: that's only for its members to see.
  if (final && !scope) res.setHeader('Cache-Control', 'public, max-age=60')
  res.json({
    game,
    period: 'daily',
    day: dayOfKey(key),
    counted: key >= (DAILY_SINCE[game] ?? 0),
    final,
    offset,
    total: page.total,
    // An id of the day's, as a day points row has one: the rows are players, not runs.
    entries: (await withAvatarIds(page.entries)).map((e) => ({ id: `day:${game}:${key}:${e.name}`, ...e })),
    you: page.you ? { score: page.you.score, place: page.you.place } : null,
  })
}

leaderboardsRouter.get('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  // One day of a daily, past or today's (dayBoard). Without a day, a board for its period, as ever.
  if (req.query.day != null && req.query.day !== '') {
    await dayBoard(req, res, game)
    return
  }
  const period = parsePeriod(req.query.period)
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const you = name ? await bestForName(game, name, period, Date.now(), scope) : null
  // A daily just for fun shows no one's runs and places no one (store.ts UNRANKED_GAMES): only the asker's own
  // result today, which another of their devices picks up from here.
  if (!isRankedGame(game)) {
    res.json({
      game,
      period,
      offset: 0,
      total: 0,
      entries: [],
      you: you && period === 'daily' ? { id: you.id, name: you.name, score: you.score, at: you.at, device: you.device } : null,
    })
    return
  }
  const { limit, offset } = pageParams(req.query)
  const page = await getBoardPage(game, period, { offset, limit, scope })
  res.json({
    game,
    period,
    offset,
    total: page.total,
    entries: await withAvatarIds(page.entries),
    you: you ? await withAvatarId(you) : null,
  })
})

/**
 * A daily game's days, newest first, for the site's archive of past days and the day-by-day workings of
 * a daily's week: each day's runs and players, its best run, and with `name`, that tag's best that day,
 * its place and the day points it earned (points are null on a day before the game's days counted,
 * DAILY_SINCE: there the place is among the day's kept runs).
 * A tries-scored game's runs from before it counted tries (a round of Ace Chase's old three holes)
 * aren't a day's result, so they're left out.
 *
 * `group` is checked as on every board, but changes nothing here: a group's week board keeps each
 * member's day points from the whole day's field and ranks them among the group, so a day's place and
 * points are the whole field's in a group too, and still add up to that board's score.
 */
leaderboardsRouter.get('/:game/days', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game || !DAILY_GAMES.has(game)) {
    res.status(404).json({ error: 'Not a daily game' })
    return
  }
  try {
    await boardAccess(req)
  } catch (err) {
    scopeError(err, res)
    return
  }
  const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name : null
  const days = await dailyDays(game, name, dayResultKeep(game))
  // A daily just for fun says how many played each day and the asker's own result, never who won or a place.
  if (!isRankedGame(game)) {
    res.setHeader('Cache-Control', 'public, max-age=60')
    res.json({
      game,
      days: days.map((d) => ({
        day: `${Math.floor(d.day / 10_000)}-${String(Math.floor(d.day / 100) % 100).padStart(2, '0')}-${String(d.day % 100).padStart(2, '0')}`,
        runs: d.runs,
        players: d.players,
        top: null,
        you: d.you ? { score: d.you.score, place: null, points: null } : null,
      })),
    })
    return
  }
  const tops = await withAvatarIds(days.map((d) => d.top))
  const iso = (key: number) => `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.json({
    game,
    days: days.map((d, i) => ({
      day: iso(d.day),
      runs: d.runs,
      players: d.players,
      top: { name: tops[i]!.name, score: tops[i]!.score, ...(tops[i]!.avatarId ? { avatarId: tops[i]!.avatarId } : {}) },
      you: d.you ? { score: d.you.score, place: d.you.place, points: d.you.points } : null,
    })),
  })
})

/**
 * A daily's records of its own (dailyRecords.ts), for the Records tab of its page: who has won the most
 * days (days that are over), and on Hot Lap and Ace Chase who holds the most past tracks' or holes'
 * records, with the numbers of the ones they hold. With `name`, where that tag stands on each, or null when
 * it has none. `place` is its place in the order shown; `tied` is how many others have as many.
 * `leaders` is how many share the top count: `top` is only the first ten.
 */
leaderboardsRouter.get('/:game/daily-records', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game || !DAILY_GAMES.has(game)) {
    res.status(404).json({ error: 'Not a daily game' })
    return
  }
  if (!isRankedGame(game)) {
    res.status(404).json({ error: 'This daily is just for fun: it has no boards', code: 'NOT_RANKED' })
    return
  }
  const who = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim().slice(0, 12).toUpperCase() : null
  const { daysWon, courseRecords } = await dailyRecords(game)
  const days = who ? standingOn(daysWon.ranked, who) : null
  const courses = who && courseRecords ? standingOn(courseRecords.ranked, who) : null
  const dayTop = await withAvatarIds(daysWon.ranked.slice(0, 10))
  const courseTop = courseRecords ? await withAvatarIds(courseRecords.ranked.slice(0, 10)) : []
  const atTop = (ranked: DailyTally[]) => (ranked[0] ? ranked.filter((t) => t.count === ranked[0]!.count).length : 0)
  res.setHeader('Cache-Control', 'public, max-age=30')
  res.json({
    game,
    daysWon: {
      closedDays: daysWon.closedDays,
      players: daysWon.ranked.length,
      leaders: atTop(daysWon.ranked),
      top: dayTop.map((t) => ({ name: t.name, days: t.count, avatarId: t.avatarId })),
      you: days ? { days: days.tally.count, place: days.place, tied: days.tied } : null,
    },
    ...(courseRecords
      ? {
          courseRecords: {
            pastCourses: courseRecords.pastCourses,
            players: courseRecords.ranked.length,
            leaders: atTop(courseRecords.ranked),
            top: courseTop.map((t) => ({ name: t.name, count: t.count, courses: t.courses, avatarId: t.avatarId })),
            you: courses ? { count: courses.tally.count, place: courses.place, tied: courses.tied, courses: courses.tally.courses } : null,
          },
        }
      : {}),
  })
})

leaderboardsRouter.get('/:game/qualifies', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const score = Number(req.query.score)
  if (!Number.isFinite(score)) {
    res.status(400).json({ error: 'score query param required' })
    return
  }

  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }

  if (isPeriod(periodParam)) {
    const ok = await qualifies(game, score, periodParam)
    res.json({
      game,
      score,
      period: periodParam,
      qualifies: ok,
      rank: ok ? await rankForScore(game, score, periodParam) : null,
      ranks: await ranksForScore(game, score),
    })
    return
  }

  const ok = await qualifiesAny(game, score)
  const ranks = await ranksForScore(game, score)
  res.json({
    game,
    score,
    qualifies: ok,
    rank: ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null,
    ranks,
  })
})

leaderboardsRouter.post('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }

  const { name, token, device, runId, challengeId, pickups, pace, pours } = parsed.data
  let score = parsed.data.score
  // Ace Chase's board takes each day's first bullseye from Today's Hole (dailyHole.ts), one an account a day.
  if (game === 'acechase') {
    res.status(409).json({ error: 'Ace Chase results come from Today’s Hole', code: 'TODAYS_HOLE_ONLY' })
    return
  }
  // Half Full's score is worked out here from the day's five pours (halffull/save.ts): the figure sent is never taken.
  if (game === 'halffull') {
    if (!pours) {
      res.status(400).json({ error: 'A Half Full day is saved with its pours', code: 'POURS_REQUIRED' })
      return
    }
    if (pours.day !== dayOfKey(boardDateKey(Date.now()))) {
      res.status(409).json({ error: firstRunError(game, 'DAY_OVER'), code: 'DAY_OVER' })
      return
    }
    const judged = judgePours(pours)
    if (!judged.ok) {
      res.status(400).json({ error: 'Those pours can’t be a run of today’s glasses', code: 'POURS_INVALID' })
      return
    }
    if (judged.board !== score) console.warn(`[halffull] a day sent as ${score} works out at ${judged.board}; kept ${judged.board}`)
    score = judged.board
  }
  if (score > scoreCeiling(game)) {
    res.status(400).json({ error: 'That score is not possible in this game', code: 'SCORE_OUT_OF_RANGE' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to save a score', code: 'AUTH_REQUIRED' })
    return
  }

  const gate = takeToken(`score:account:${account.id}`, SUBMIT_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many scores too quickly', code: 'RATE_LIMITED' })
    return
  }

  /*
   * The run is what makes the score checkable, but it cannot be demanded until
   * every client sends one — a released build that posts without a runId must
   * keep working through the deploy. REQUIRE_RUN_TOKEN closes that door once
   * the site has caught up.
   */
  // A day's Marble Run can't be rolled much faster than the day's blue ball, the plan's own (marblerunPace.ts): a
  // time under 60% of it is refused, whatever the clock says. The loosest guess at the best a hand could do.
  if (game === 'marblerun' && TIME_SCORE_BASE - score < 0.6 * (marblerunPlannedPace() ?? 42_000)) {
    console.warn(`[anticheat] rejected marblerun ${score} from account ${account.id}: faster than the day's course allows`)
    res.status(400).json({ error: 'That score is not possible in the time the run took', code: 'SCORE_IMPLAUSIBLE' })
    return
  }
  // Nor a day's Lander much faster than the day's blue ship (landerPace.ts). A hand can cut a cave's corners
  // and dive where the blue ship eases down, so the floor is lower: 45% of its time.
  if (game === 'lander' && TIME_SCORE_BASE - score < 0.45 * (landerPlannedPace() ?? 49_000)) {
    console.warn(`[anticheat] rejected lander ${score} from account ${account.id}: faster than the day's cave allows`)
    res.status(400).json({ error: 'That score is not possible in the time the run took', code: 'SCORE_IMPLAUSIBLE' })
    return
  }

  const firstRunOnly = FIRST_RUN_DAILIES.has(game)
  let durationMs: number | null = null
  if (runId) {
    const run = await peekRun(runId, account.id, game, firstRunOnly ? FIRST_RUN_TTL_MS : undefined)
    if (!run.ok) {
      res.status(400).json({ error: RUN_ERRORS[run.code], code: `RUN_${run.code}` })
      return
    }
    durationMs = run.elapsedMs
    // Five pours can't be locked faster than each glass's lock allows (halffull/save.ts minPourMs).
    if (game === 'halffull' && run.elapsedMs < minPourMs(pours?.auto)) {
      console.warn(`[anticheat] rejected halffull from account ${account.id}: five pours in ${run.elapsedMs}ms`)
      res.status(400).json({ error: 'That score is not possible in the time the run took', code: 'SCORE_IMPLAUSIBLE' })
      return
    }
    const plausible = checkScoreRate(game, score, run.elapsedMs)
    if (!plausible.ok) {
      console.warn(
        `[anticheat] rejected ${game} ${score} from account ${account.id} after ${run.elapsedMs}ms: ${plausible.reason}`,
      )
      res.status(400).json({
        error: 'That score is not possible in the time the run took',
        code: 'SCORE_IMPLAUSIBLE',
      })
      return
    }
  } else if (REQUIRE_RUN_TOKEN) {
    res.status(400).json({ error: 'Start the run before saving a score', code: 'RUN_REQUIRED' })
    return
  }

  // Find the Bug's board takes an account's first run of the day, and one a day (firstRun.ts).
  if (firstRunOnly) {
    const problem = await firstRunProblem(account.id, game, runId ?? null)
    if (problem) {
      res.status(409).json({ error: firstRunError(game, problem), code: problem })
      return
    }
  }

  let claim: { name: string; token: string }
  try {
    claim = await assertCanUseName(name, {
      claimToken: token,
      accountId: account.id,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Name claim failed',
      code,
    })
    return
  }

  /*
   * Checked on the resolved claim rather than the submitted name, so a banned
   * player cannot get past it by letting the server tidy their tag for them,
   * and on the account too, so a fresh tag is not a way back on.
   */
  if (await isBanned(claim.name, account.id)) {
    console.log(`[admin] refused a ${game} score from banned ${claim.name}`)
    res.status(403).json({
      error: 'This tag cannot post scores',
      code: 'NAME_BANNED',
    })
    return
  }

  // Last thing before the write: everything that could reject this score has
  // already had its say, so spending the run here cannot strand a retry.
  if (runId && !(await claimRun(runId, 'leaderboard'))) {
    res.status(400).json({ error: RUN_ERRORS.USED, code: 'RUN_USED' })
    return
  }
  // Two saves of the day racing (two devices): the first to hold the day is the one that counts.
  if (firstRunOnly && !(await claimFirstRunDay(account.id, game))) {
    res.status(409).json({ error: firstRunError(game, 'DAILY_DONE'), code: 'DAILY_DONE' })
    return
  }

  // Read before the write, so "was this far past the rest?" has an answer: a daily's today, the others' all time
  // (a daily's all-time board is its days' points, store.ts dayPointsBoard, not a score to measure a run against).
  const bestBefore = (await getBoard(game, DAILY_GAMES.has(game) ? 'daily' : 'all'))[0]?.score ?? 0
  // The player's own best before this run, for its tickets: a new best pays more, and none at all is a first go.
  // A daily's is its day points, which say only whether this is a first go (tickets.ts pays it no best).
  const priorBest = (await bestForName(game, claim.name, 'all'))?.score ?? null

  const result = await addScore(game, claim.name, score, device ?? 'desktop', {
    runId: runId ?? null,
    durationMs,
    ipHash: hashIp(clientIp(req)),
    userAgent: req.get('user-agent') ?? null,
  })
  // A daily just for fun keeps no record book (store.ts UNRANKED_GAMES).
  const ranked = isRankedGame(game)
  const streakRecords = ranked ? await updateCrossRunStreakRecords(game, claim.name, score, device ?? 'desktop') : []
  // A lap of today's Hot Lap track goes in its track's record book too (courseRecords.ts).
  if (ranked && DAILY_GAMES.has(game)) await noteDayRun(game, claim.name, score, device ?? 'desktop', result.entry.at)

  // The site's records (streaks, busiest day) catch up within their minute
  // (siteRecords.ts). Clearing them on every save made nearly every home page
  // visit under steady play read the whole score table again.

  // After the save, never in its way: a suspicion is a note for a person.
  await flagIfSuspicious(
    {
      scoreId: result.entry.id,
      game,
      name: claim.name,
      score,
      runId: runId ?? null,
      durationMs,
    },
    bestBefore,
  )

  // A run from a friend's link: kept against the challenge, and its sender told.
  const challenge = challengeId
    ? await recordChallengeRun({
        challengeId,
        game,
        name: claim.name,
        accountId: account.id,
        score,
        scoreId: result.entry.id,
      }).catch((err: unknown) => {
        console.warn(`[challenges] ${challengeId}:`, err)
        return null
      })
    : null

  // Tickets for a run the server timed; one saved without a run id pays none, but for a Half Full day, whose
  // score the server worked out itself and which saves once a day: it's paid under the day.
  const payRef = runId ?? (game === 'halffull' ? `halffull-${boardDateKey(result.entry.at)}` : null)
  const tickets: RunTickets | null = payRef
    ? await payRun({
        accountId: account.id,
        game,
        runId: payRef,
        entry: result.entry,
        score,
        priorBest,
        pickups: game === 'crosswalk' ? plausiblePickups(score, pickups) : 0,
        paceMs: game === 'hotlap' || game === 'marblerun' || game === 'lander' ? pace : null,
      }).catch((err: unknown) => {
        console.warn(`[tickets] ${game} run ${payRef}:`, err)
        return null
      })
    : null

  // Any secrets the run found (secrets.ts), once it's on the board.
  const secrets = await secretsForRun({
    accountId: account.id,
    name: claim.name,
    game,
    score,
    record: bestBefore,
    offset: clientOffset(req),
    at: result.entry.at,
    entryId: result.entry.id,
  }).catch((err: unknown) => {
    console.warn(`[secrets] ${game} run for ${claim.name}:`, err)
    return []
  })

  // A daily of the Today set (today.ts) may keep the day, or make it a Full ticket, and reach a streak reward.
  if (game === 'hotlap' || game === 'findbug' || game === 'halffull' || game === 'marblerun') {
    await settleToday(account.id, result.entry.at).catch((err: unknown) => {
      console.warn(`[today] ${game} run for ${claim.name}:`, err)
    })
    // And it may beat a friend's result on it today (todayBeaten.ts). The save doesn't wait: a push can take a moment.
    void tellBeatenFriends({ accountId: account.id, game, now: result.entry.at }).catch((err: unknown) => {
      console.warn(`[today] telling ${claim.name}'s friends:`, err)
    })
  }

  res.status(201).json({
    game,
    challenge,
    tickets,
    ...(secrets.length ? { secrets } : {}),
    entry: await withAvatarId(result.entry),
    // A daily just for fun places the run nowhere, and its board is no one's to see.
    rank: ranked ? result.rank : null,
    ranks: ranked ? result.ranks : {},
    previousBestRanks: ranked ? result.previousBestRanks : {},
    bestRanks: ranked ? result.bestRanks : {},
    streakRecords,
    period: 'daily',
    entries: ranked ? await withAvatarIds(result.board) : [],
    name: claim.name,
    token: claim.token,
  })
})
