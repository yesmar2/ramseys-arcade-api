import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { clientIp, takeToken } from './rateLimit.js'
import { recordShare } from './shares.js'

export const sharesRouter = Router()

const noteSchema = z.object({
  kind: z.string().min(1).max(40),
  game: z.string().max(40).nullish(),
  how: z.enum(['sheet', 'copy', 'place']),
})

/** Per address, then for everyone together, so a flood can't fill the table: a share is a tap. */
const PER_IP = { limit: 30, windowMs: 10 * 60_000 }
const EVERYONE = { limit: 3000, windowMs: 10 * 60_000 }

/** A player sent something on (shares.ts). Anyone may say so, signed in or not. */
sharesRouter.post('/', async (req, res) => {
  const parsed = noteSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }
  if (!takeToken(`shares:ip:${clientIp(req)}`, PER_IP).ok || !takeToken('shares:all', EVERYONE).ok) {
    res.status(429).json({ error: 'Too many shares', code: 'RATE_LIMITED' })
    return
  }
  try {
    const account = await accountFromRequest(req).catch(() => null)
    await recordShare(parsed.data, account?.id ?? null)
    res.status(204).end()
  } catch (err) {
    console.warn('[shares] could not keep a share:', err)
    res.status(500).json({ error: 'Could not keep the share' })
  }
})
