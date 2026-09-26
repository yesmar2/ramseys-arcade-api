import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { dailyReply, recordResult } from './dailyHole.js'
import { takeToken } from './rateLimit.js'

export const dailyHoleRouter = Router()

/** One result a day, and a retry or two: this only stops a script. */
const RESULT_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 }

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

/** Today's Hole: how many got it and in how many tries, and signed in, how you did. */
dailyHoleRouter.get('/', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    res.json(await dailyReply(account?.id ?? null))
  } catch (err) {
    fail(err, res)
  }
})

const resultSchema = z.object({
  day: z.string().length(10),
  tries: z.number().int().min(1).max(400),
  pattern: z.string().min(1).max(400),
})

/** Keep today's result: the tries the first bullseye took. The first one sent stands. */
dailyHoleRouter.post('/results', async (req, res) => {
  const parsed = resultSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep your result', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`daily-hole:account:${account.id}`, RESULT_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many results too quickly', code: 'RATE_LIMITED' })
    return
  }
  try {
    res.json(await recordResult(account.id, parsed.data))
  } catch (err) {
    fail(err, res)
  }
})
