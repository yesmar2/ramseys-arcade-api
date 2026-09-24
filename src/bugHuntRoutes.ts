import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { huntReply, recordFinds } from './bugHunt.js'
import { takeToken } from './rateLimit.js'

export const bugHuntRouter = Router()

/** A catch a day, and a device's backlog once: this only stops a script. */
const FIND_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 }

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

/** Today's hunt: how many caught its bug, and, signed in, your finds and where yours came in. */
bugHuntRouter.get('/', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    res.json(await huntReply(account?.id ?? null))
  } catch (err) {
    fail(err, res)
  }
})

const findsSchema = z.object({
  finds: z
    .array(
      z.object({
        day: z.string().length(10),
        bug: z.string().min(1).max(20),
        spot: z.string().min(1).max(40),
        at: z.number().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(400),
})

/** Keep finds: the one just caught, or the ones this device made before signing in. */
bugHuntRouter.post('/finds', async (req, res) => {
  const parsed = findsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep your finds', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`hunt:account:${account.id}`, FIND_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many finds too quickly', code: 'RATE_LIMITED' })
    return
  }
  try {
    res.json(await recordFinds(account.id, parsed.data.finds))
  } catch (err) {
    fail(err, res)
  }
})
