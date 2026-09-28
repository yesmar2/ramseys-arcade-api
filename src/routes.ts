import { checkScoreRate, scoreCeiling, TRIES_SCORE_BASE, TRIES_SCORED_GAMES } from './scoreLimits.js'
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
import { recordChallengeRun } from './challenges.js'
import { payRun, plausiblePickups, type RunTickets } from './tickets.js'
import {
  addScore,
  ALLOWED_GAMES,
  bestForName,
  bestsForName,
  boardDateKey,
  boardsSummaryForPeriod,
  DAILY_GAMES,
  dailyDays,
  getBoard,
  getBoardPage,
  globalRanksPage,
  isPeriod,
  qualifies,
  qualifiesAny,
  rankForName,
  rankForScore,
  ranksForScore,
  resolveGameSlug,
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

leaderboardsRouter.get('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
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
 * A daily game's days, newest first, for the site's archive of past days: each day's runs and players,
 * its best run, and with `name`, that tag's best that day. A tries-scored game's runs from before it
 * counted tries (a round of Ace Chase's old three holes) aren't a day's result, so they're left out.
 */
leaderboardsRouter.get('/:game/days', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game || !DAILY_GAMES.has(game)) {
    res.status(404).json({ error: 'Not a daily game' })
    return
  }
  const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name : null
  const keep = TRIES_SCORED_GAMES.has(game) ? (score: number) => score > TRIES_SCORE_BASE - 1000 : undefined
  const days = await dailyDays(game, name, keep)
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
      you: d.you ? { score: d.you.score } : null,
    })),
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
  const streakRecords = await updateCrossRunStreakRecords(
    game,
    claim.name,
    score,
    device ?? 'desktop',
  )
  // A lap of today's Hot Lap track, or Find the Bug's or Half Full's run of the day, goes in that day's record book too (courseRecords.ts).
  if (DAILY_GAMES.has(game)) await noteDayRun(game, claim.name, score, device ?? 'desktop', result.entry.at)

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
        paceMs: game === 'hotlap' ? pace : null,
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

  // A daily of the Today set (today.ts) may finish the day's punch card and reach a streak reward.
  if (game === 'hotlap' || game === 'findbug') {
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
    rank: result.rank,
    ranks: result.ranks,
    previousBestRanks: result.previousBestRanks,
    bestRanks: result.bestRanks,
    streakRecords,
    period: 'daily',
    entries: await withAvatarIds(result.board),
    name: claim.name,
    token: claim.token,
  })
})
