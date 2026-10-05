import { giveMembersLooks } from './plus.js'
import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { takeToken } from './rateLimit.js'
import { allLadders } from './ticketLadders.js'
import { HISTORY_KINDS, setGoal, ticketHistory, ticketsFor, tradePrize } from './tickets.js'

/*
 * The prize counter: a player's tickets, and trading them for prizes.
 * Earning happens where the play is (a saved run, the Daily, the bug hunt).
 */
export const ticketsRouter = Router()

/** More trades than anyone makes browsing a counter; only a script hits it. */
const TRADE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 }

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

/** What a run pays, game by game, for the site to show beside how to play: anyone can ask. */
ticketsRouter.get('/ladders', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=600')
    res.json({ ladders: await allLadders() })
  } catch (err) {
    fail(err, res)
  }
})

/** Your tickets: what you have, what came in today, your goal, your prizes and the latest in and out. */
ticketsRouter.get('/', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to collect tickets', code: 'AUTH_REQUIRED' })
    return
  }
  try {
    // A Plus member's look for the month arrives with what they own, wherever they open the site.
    await giveMembersLooks(account.id, account.plan)
    res.json(await ticketsFor(account.id))
  } catch (err) {
    fail(err, res)
  }
})

const historySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  kind: z.enum(HISTORY_KINDS).optional(),
  game: z.string().min(1).max(32).optional(),
})

/** Your tickets in and out, newest first, a week of days with something in them at a time. */
ticketsRouter.get('/history', async (req, res) => {
  const parsed = historySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', code: 'INVALID_QUERY' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to see your tickets', code: 'AUTH_REQUIRED' })
    return
  }
  try {
    res.json(await ticketHistory(account.id, parsed.data))
  } catch (err) {
    fail(err, res)
  }
})

const tradeSchema = z.object({ prize: z.string().min(1).max(32) })

/** Trade tickets for a prize. Answers with the tickets as they stand after. */
ticketsRouter.post('/trade', async (req, res) => {
  const parsed = tradeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to trade tickets', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`trade:account:${account.id}`, TRADE_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many trades too quickly', code: 'RATE_LIMITED' })
    return
  }
  try {
    await tradePrize(account.id, parsed.data.prize)
    res.json(await ticketsFor(account.id))
  } catch (err) {
    fail(err, res)
  }
})

const goalSchema = z.object({ prize: z.string().min(1).max(32).nullable() })

/** The prize you're saving for, or none. */
ticketsRouter.put('/goal', async (req, res) => {
  const parsed = goalSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to save for a prize', code: 'AUTH_REQUIRED' })
    return
  }
  try {
    res.json({ goal: await setGoal(account.id, parsed.data.prize) })
  } catch (err) {
    fail(err, res)
  }
})
