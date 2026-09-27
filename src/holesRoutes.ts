import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { isBanned } from './bans.js'
import { noteCourseRecord } from './courseRecords.js'
import {
  addHoleResult,
  holeBoard,
  holeNumber,
  holeRecords,
  HOLE_GAMES,
  holeState,
  nameDayResult,
  resultOnHole,
  type HoleEntry,
} from './holes.js'
import { assertCanUseName, withAvatarIds } from './names.js'
import { takeToken } from './rateLimit.js'
import { resolveGameSlug, type GameSlug } from './store.js'
import { awardTickets, RECORD_TICKETS } from './tickets.js'

/*
 * Hole records (holes.ts): every Ace Chase hole's own board, for good.
 *
 *   GET  /holes/:game/records?name=      every hole that has had its day: its record, players, your result and place
 *   GET  /holes/:game/:day/board?name=   a hole's board: the top ten and where you stand
 *   POST /holes/:game/:day/results       a result on a hole after its day: the account's first on it, if it has
 *                                        none from its day; into the hole's record book too, and taking the record
 *                                        pays RECORD_TICKETS once
 */
export const holesRouter = Router()

/** The same budget as a day's saves (routes.ts), in the same bucket. */
const SUBMIT_LIMIT = { limit: 40, windowMs: 10 * 60 * 1000 }

const resultSchema = z.object({
  name: z.string().min(1).max(12),
  token: z.string().min(1).max(128).optional(),
  tries: z.number().int().min(1).max(400),
  /** One letter a try (b bull, i inner ring, o outer ring, x off them, l lost), as Today's Hole sends. */
  pattern: z.string().regex(/^[bioxl]{1,400}$/),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
})

function holeGame(raw: string): GameSlug | null {
  const game = resolveGameSlug(raw)
  return game && HOLE_GAMES.has(game) ? game : null
}

const cleanName = (raw: unknown) => (typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 12).toUpperCase() : null)

const figure = (e: { name: string; tries: number; avatarId?: string }) => ({
  name: e.name,
  tries: e.tries,
  ...(e.avatarId ? { avatarId: e.avatarId } : {}),
})

/** Where a tag stands on a hole's board. */
function standing(board: HoleEntry[], name: string) {
  const at = board.findIndex((e) => e.name === name)
  return at >= 0 ? { tries: board[at]!.tries, place: at + 1 } : null
}

holesRouter.get('/:game/records', async (req, res) => {
  const game = holeGame(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'No hole records for that game' })
    return
  }
  const records = await holeRecords(game, cleanName(req.query.name))
  const holders = await withAvatarIds(records.map((r) => ({ name: r.record?.name ?? '' })))
  res.setHeader('Cache-Control', 'public, max-age=30')
  res.json({
    game,
    holes: records.map((r, i) => ({
      n: r.n,
      day: r.day,
      players: r.players,
      record: r.record ? figure({ ...r.record, avatarId: holders[i]!.avatarId }) : null,
      you: r.you,
    })),
  })
})

holesRouter.get('/:game/:day/board', async (req, res) => {
  const game = holeGame(req.params.game)
  const day = req.params.day
  const state = holeState(day)
  if (!game || state === 'none') {
    res.status(404).json({ error: 'No such hole' })
    return
  }
  const board = state === 'ahead' ? [] : await holeBoard(game, day)
  const who = cleanName(req.query.name)
  const top = await withAvatarIds(board.slice(0, 10))
  res.setHeader('Cache-Control', 'public, max-age=15')
  res.json({
    game,
    day,
    n: holeNumber(day),
    state,
    players: board.length,
    entries: top.map(figure),
    you: who ? standing(board, who) : null,
  })
})

holesRouter.post('/:game/:day/results', async (req, res) => {
  const game = holeGame(req.params.game)
  const day = req.params.day
  const state = holeState(day)
  if (!game || state === 'none') {
    res.status(404).json({ error: 'No such hole' })
    return
  }
  // Today's Hole is played for the day's board (dailyHole.ts). One still to come is only a trial.
  if (state === 'today') {
    res.status(409).json({ error: 'This is today’s hole: its results go on today’s board', code: 'TODAYS_HOLE' })
    return
  }
  if (state === 'ahead') {
    res.status(409).json({ error: 'This hole’s day hasn’t come yet', code: 'HOLE_AHEAD' })
    return
  }
  const parsed = resultSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const { name, token, tries, pattern, device } = parsed.data
  // One letter a try, the last of them the bullseye and the only one: the first bullseye ends the hole.
  if (pattern.length !== tries || pattern.indexOf('b') !== tries - 1) {
    res.status(400).json({ error: 'That result doesn’t add up', code: 'INVALID_RESULT' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to put a result on the board', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`score:account:${account.id}`, SUBMIT_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many results too quickly', code: 'RATE_LIMITED' })
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
  const before = await holeBoard(game, day)
  const had = await resultOnHole(game, account.id, day)
  // The account's first result on the hole is its only one: this one is practice.
  let kept = false
  if (had) {
    // One from its day that came in with no tag goes on the board now, under the tag it has.
    if (had.onItsDay && !had.name) {
      await nameDayResult(account.id, day, claim.name)
      await noteCourseRecord(game, holeNumber(day), claim.name, had.tries, device ?? 'desktop')
    }
  } else {
    kept = await addHoleResult({ game, day, accountId: account.id, name: claim.name, tries, pattern, device: device ?? 'desktop', at: Date.now() })
    if (kept) await noteCourseRecord(game, holeNumber(day), claim.name, tries, device ?? 'desktop')
  }
  const after = await holeBoard(game, day)
  const mine = standing(after, claim.name)
  const record = after[0] ?? null
  // Took the record with this result, from someone else or from nobody: fewer tries than the last.
  const tookRecord = kept && record?.name === claim.name && record.tries === tries && (!before[0] || tries < before[0].tries)
  const tickets = tookRecord
    ? await awardTickets(account.id, 'record', `${game}:hole:${day}`, RECORD_TICKETS, game).catch((err: unknown) => {
        console.warn(`[tickets] ${game} hole ${day} record for ${claim.name}:`, err)
        return null
      })
    : null
  res.json({
    game,
    day,
    n: holeNumber(day),
    name: claim.name,
    tries,
    /** Whether this result went on the board: false when the account had one on the hole already. */
    kept,
    /** The account's result on the board, and its place. */
    you: mine,
    players: after.length,
    record: record ? { name: record.name, tries: record.tries } : null,
    tookRecord,
    ...(tickets?.earned ? { tickets } : {}),
  })
})
