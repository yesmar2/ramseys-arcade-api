import { Router } from 'express'
import { z } from 'zod'
import { clientIp, takeToken } from './rateLimit.js'
import { KINDS, recordSource, TAG } from './sources.js'

export const sourcesRouter = Router()

const noteSchema = z.object({
  src: z.string().regex(TAG),
  kind: z.enum(KINDS),
})

/** Per address, then for everyone together, so a flood can't fill the counts: a device says at most four a day. */
const PER_IP = { limit: 20, windowMs: 10 * 60_000 }
const EVERYONE = { limit: 3000, windowMs: 10 * 60_000 }

/** A device that came in on a tagged link says where it is with it (sources.ts). Anyone may, signed in or not. */
sourcesRouter.post('/', async (req, res) => {
  const parsed = noteSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }
  if (!takeToken(`sources:ip:${clientIp(req)}`, PER_IP).ok || !takeToken('sources:all', EVERYONE).ok) {
    res.status(429).json({ error: 'Too many', code: 'RATE_LIMITED' })
    return
  }
  try {
    await recordSource(parsed.data.src, parsed.data.kind)
    res.status(204).end()
  } catch (err) {
    console.warn('[sources] could not count a visit:', err)
    res.status(500).json({ error: 'Could not count it' })
  }
})
