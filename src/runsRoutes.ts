import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { clientIp, takeToken } from './rateLimit.js'
import { startRun } from './runs.js'
import { resolveGameSlug } from './store.js'

export const runsRouter = Router()

const startSchema = z.object({ game: z.string().min(1).max(40) })

/*
 * A death-and-restart loop is the normal way to play, so the per-account
 * allowance is loose — one start every five seconds, sustained. The address
 * limit sits above it to blunt a flood from one machine cycling accounts.
 */
const START_LIMIT = { limit: 120, windowMs: 10 * 60 * 1000 }
const START_IP_LIMIT = { limit: 400, windowMs: 10 * 60 * 1000 }

/**
 * Open a run.
 *
 * Costs the player one request at game start and buys the server the only
 * thing it otherwise has no way to know: when the run began.
 */
runsRouter.post('/start', async (req, res) => {
  const ipGate = takeToken(`run-start:ip:${clientIp(req)}`, START_IP_LIMIT)
  if (!ipGate.ok) {
    res.setHeader('Retry-After', Math.ceil(ipGate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many runs started', code: 'RATE_LIMITED' })
    return
  }

  const parsed = startSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }

  const game = resolveGameSlug(parsed.data.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game', code: 'UNKNOWN_GAME' })
    return
  }

  /*
   * No sign-in needed. Saving a score still requires an account, but starting
   * a game never has, and a player who signs in at the save card would
   * otherwise arrive there with no run to show for the game they just played.
   */
  const account = await accountFromRequest(req)
  if (account) {
    const gate = takeToken(`run-start:account:${account.id}`, START_LIMIT)
    if (!gate.ok) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
      res.status(429).json({ error: 'Too many runs started', code: 'RATE_LIMITED' })
      return
    }
  }

  const ticket = await startRun(account?.id ?? null, game)
  res.status(201).json({ game, runId: ticket.runId, startedAt: ticket.startedAt })
})
