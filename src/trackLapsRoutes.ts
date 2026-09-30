import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { isBanned } from './bans.js'
import { GHOST_GAMES, GHOST_RATE, ghostFor, ghostProblem, ghostState, keepGhost } from './lapGhosts.js'
import { assertCanUseName, namesOwnedByAccount, withAvatarIds } from './names.js'
import { takeToken } from './rateLimit.js'
import { noteCourseRecord } from './courseRecords.js'
import { claimRun, peekRun } from './runs.js'
import { checkScoreRate, scoreCeiling, TIME_SCORE_BASE } from './scoreLimits.js'
import { resolveGameSlug, type GameSlug } from './store.js'
import { awardTickets, RECORD_TICKETS } from './tickets.js'
import { addTrackLap, fastestBelievable, TRACK_GAMES, trackBoard, trackDayIso, trackRecords, trackState } from './trackLaps.js'

/*
 * Track records (trackLaps.ts): every Hot Lap track's own board, for good.
 *
 *   GET  /tracks/:game/records?name=   every track that has had its day: its record (and when it was driven),
 *                                      drivers, your best and place
 *   GET  /tracks/:game/:n/board?name=  a track's board: the top ten and where you stand (nobody's, for a track
 *                                      still to come)
 *   POST /tracks/:game/:n/laps         a lap on a track after its day, checked as a day's lap is; into the
 *                                      track's record book too, and taking the record pays RECORD_TICKETS once
 *   GET  /tracks/:game/:n/ghost        the track's #1, and their lap's path if it came with one (lapGhosts.ts)
 *   POST /tracks/:game/:n/ghost        a saved lap's path, kept if it's the track's fastest yet
 *
 * The ghosts are Marble Run's too, a course's n for a track's (/tracks/marblerun/:n/ghost): a course has
 * only its day's board, and no records of its own here.
 */
export const tracksRouter = Router()

/** The same budget as a day's saves (routes.ts), in the same bucket, so the two can't be played off each other. */
const SUBMIT_LIMIT = { limit: 40, windowMs: 10 * 60 * 1000 }

const RUN_ERRORS: Record<'UNKNOWN' | 'USED' | 'EXPIRED' | 'MISMATCH', string> = {
  UNKNOWN: 'That run is not on record',
  USED: 'That run already saved a lap',
  EXPIRED: 'That run is too old to save',
  MISMATCH: 'That run belongs to a different game',
}

const lapSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().positive().max(1_000_000),
  token: z.string().min(1).max(128).optional(),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
  runId: z.string().min(1).max(64),
})

function trackGame(raw: string): GameSlug | null {
  const game = resolveGameSlug(raw)
  return game && TRACK_GAMES.has(game) ? game : null
}

const cleanName = (raw: unknown) => (typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 12).toUpperCase() : null)

tracksRouter.get('/:game/records', async (req, res) => {
  const game = trackGame(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'No track records for that game' })
    return
  }
  const records = await trackRecords(game, cleanName(req.query.name))
  const holders = await withAvatarIds(records.map((r) => ({ name: r.record?.name ?? '' })))
  res.setHeader('Cache-Control', 'public, max-age=30')
  res.json({
    game,
    tracks: records.map((r, i) => ({
      track: r.track,
      day: r.day,
      drivers: r.drivers,
      // `at`: when the record was driven, on the track's day or since.
      record: r.record
        ? { name: r.record.name, score: r.record.score, at: r.record.at, ...(holders[i]!.avatarId ? { avatarId: holders[i]!.avatarId } : {}) }
        : null,
      you: r.you,
    })),
  })
})

tracksRouter.get('/:game/:n/board', async (req, res) => {
  const game = trackGame(req.params.game)
  const n = Number(req.params.n)
  const state = trackState(n)
  if (!game || state === 'none') {
    res.status(404).json({ error: 'No such track' })
    return
  }
  const board = state === 'ahead' ? [] : await trackBoard(game, n)
  const who = cleanName(req.query.name)
  const mine = who ? board.findIndex((e) => e.name === who) : -1
  const top = (await withAvatarIds(board.slice(0, 10))).map((e) => ({ name: e.name, score: e.score, ...(e.avatarId ? { avatarId: e.avatarId } : {}) }))
  res.setHeader('Cache-Control', 'public, max-age=15')
  res.json({
    game,
    track: n,
    day: trackDayIso(n),
    state,
    drivers: board.length,
    entries: top,
    // The same again under the names every course board uses (a hole's has them too): the top ten, and how many are on it.
    top,
    players: board.length,
    you: mine >= 0 ? { score: board[mine]!.score, place: mine + 1 } : null,
  })
})

tracksRouter.post('/:game/:n/laps', async (req, res) => {
  const game = trackGame(req.params.game)
  const n = Number(req.params.n)
  const state = trackState(n)
  if (!game || state === 'none') {
    res.status(404).json({ error: 'No such track' })
    return
  }
  // Today's track is the Daily: its laps go on the day's board. One still to come is only a test drive.
  if (state === 'today') {
    res.status(409).json({ error: 'This is today’s track: its laps go on today’s board', code: 'TODAYS_TRACK' })
    return
  }
  if (state === 'ahead') {
    res.status(409).json({ error: 'This track’s day hasn’t come yet', code: 'TRACK_AHEAD' })
    return
  }
  const parsed = lapSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const { name, score, token, device, runId } = parsed.data
  if (score > scoreCeiling(game) || TIME_SCORE_BASE - score < fastestBelievable(n)) {
    res.status(400).json({ error: 'That lap is not possible on this track', code: 'SCORE_OUT_OF_RANGE' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to save a lap', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`score:account:${account.id}`, SUBMIT_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many laps too quickly', code: 'RATE_LIMITED' })
    return
  }
  // Timed by the server as a day's lap is: it can't have taken less time than it claims.
  const run = await peekRun(runId, account.id, game)
  if (!run.ok) {
    res.status(400).json({ error: RUN_ERRORS[run.code], code: `RUN_${run.code}` })
    return
  }
  const plausible = checkScoreRate(game, score, run.elapsedMs)
  if (!plausible.ok) {
    console.warn(`[anticheat] rejected a ${game} track ${n} lap of ${score} from account ${account.id} after ${run.elapsedMs}ms: ${plausible.reason}`)
    res.status(400).json({ error: 'That lap is not possible in the time the run took', code: 'SCORE_IMPLAUSIBLE' })
    return
  }
  let claim: { name: string; token: string }
  try {
    claim = await assertCanUseName(name, { claimToken: token, accountId: account.id })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: err instanceof Error ? err.message : 'Name claim failed', code: (err as { code?: string }).code })
    return
  }
  if (await isBanned(claim.name, account.id)) {
    res.status(403).json({ error: 'This tag cannot post scores', code: 'NAME_BANNED' })
    return
  }
  const before = await trackBoard(game, n)
  // Last before the write, as a day's save does it: one run, one board, the day's or a track's.
  if (!(await claimRun(runId, 'leaderboard'))) {
    res.status(400).json({ error: RUN_ERRORS.USED, code: 'RUN_USED' })
    return
  }
  await addTrackLap({ game, track: n, accountId: account.id, name: claim.name, score, device: device ?? 'desktop', runId, durationMs: run.elapsedMs })
  // Into the track's record book too, as its board has it.
  await noteCourseRecord(game, n, claim.name, TIME_SCORE_BASE - score, device ?? 'desktop')
  const after = await trackBoard(game, n)
  const place = after.findIndex((e) => e.name === claim.name) + 1
  const record = after[0]!
  // Took the record with this lap, from someone else or from nobody.
  const tookRecord = record.name === claim.name && record.score === score && (before[0]?.score ?? 0) < score
  // A few tickets for taking it, once a track, however often it changes hands.
  const tickets = tookRecord
    ? await awardTickets(account.id, 'record', `${game}:track:${n}`, RECORD_TICKETS, game).catch((err: unknown) => {
        console.warn(`[tickets] ${game} track ${n} record for ${claim.name}:`, err)
        return null
      })
    : null
  res.json({
    game,
    track: n,
    name: claim.name,
    score,
    best: after[place - 1]!.score,
    place,
    drivers: after.length,
    record: { name: record.name, score: record.score },
    tookRecord,
    ...(tickets?.earned ? { tickets } : {}),
  })
})

/* ---------------------------------------------------------------- ghosts --- */

/** Paths are sent only after a lap is saved, so a few a minute is plenty. */
const GHOST_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 }

const ghostSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().positive().max(1_000_000),
  // A lap's three sectors; a marble run's checkpoints and goal (lapGhosts.ts checks which).
  splits: z.array(z.number()).min(1).max(12),
  path: z.array(z.number()).max(18_000),
})

function ghostGame(raw: string): GameSlug | null {
  const game = resolveGameSlug(raw)
  return game && GHOST_GAMES.has(game) ? game : null
}

tracksRouter.get('/:game/:n/ghost', async (req, res) => {
  const game = ghostGame(req.params.game)
  const n = Number(req.params.n)
  if (!game || ghostState(game, n) === 'none') {
    res.status(404).json({ error: 'No such track' })
    return
  }
  const top = await ghostFor(game, n)
  if (!top) {
    res.status(404).json({ error: 'Nobody has a lap on this track yet', code: 'NO_GHOST' })
    return
  }
  const [holder] = await withAvatarIds([{ name: top.name }])
  res.setHeader('Cache-Control', 'public, max-age=30')
  res.json({
    game,
    track: n,
    name: top.name,
    avatarId: holder?.avatarId,
    time: top.timeMs,
    // Without a path, the site drives the blue car's line at this time.
    ...(top.ghost ? { splits: top.ghost.splits, rate: GHOST_RATE, path: top.ghost.path } : { path: null }),
  })
})

tracksRouter.post('/:game/:n/ghost', async (req, res) => {
  const game = ghostGame(req.params.game)
  const n = Number(req.params.n)
  const state = game ? ghostState(game, n) : 'none'
  // A track still to come is only a test drive: no board, so no ghost.
  if (!game || state === 'none' || state === 'ahead') {
    res.status(404).json({ error: 'No such track' })
    return
  }
  const parsed = ghostSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to send a lap', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`ghost:account:${account.id}`, GHOST_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many laps too quickly', code: 'RATE_LIMITED' })
    return
  }
  const { name, score, splits, path } = parsed.data
  const timeMs = TIME_SCORE_BASE - score
  const problem = ghostProblem(game, timeMs, splits, path)
  if (problem) {
    res.status(400).json({ error: 'That path isn’t a lap of that time', code: 'GHOST_INVALID', reason: problem })
    return
  }
  const names = (await namesOwnedByAccount(account.id)).map((claim) => claim.name)
  const kept = await keepGhost({ game, track: n, accountId: account.id, names, name: cleanName(name) ?? name, timeMs, splits, path })
  res.json({ kept })
})
