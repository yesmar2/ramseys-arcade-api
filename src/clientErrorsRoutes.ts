import { Router } from 'express'
import { z } from 'zod'
import { recordClientError } from './clientErrors.js'
import { clientIp, takeToken } from './rateLimit.js'

export const clientErrorsRouter = Router()

const reportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(1000).optional(),
  release: z.string().max(100).optional(),
})

/** Per address, then for everyone together, so a flood can't fill the table. */
const PER_IP = { limit: 20, windowMs: 10 * 60_000 }
const EVERYONE = { limit: 600, windowMs: 10 * 60_000 }

/** A browser saying something broke. Anyone may send one, signed in or not. */
clientErrorsRouter.post('/', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  const gate = takeToken(`client-errors:ip:${clientIp(req)}`, PER_IP)
  if (!gate.ok || !takeToken('client-errors:all', EVERYONE).ok) {
    res.status(429).json({ error: 'Too many reports', code: 'RATE_LIMITED' })
    return
  }
  try {
    await recordClientError(parsed.data, String(req.headers['user-agent'] ?? ''))
    res.status(204).end()
  } catch (err) {
    console.warn('[client-errors] could not keep a report:', err)
    res.status(500).json({ error: 'Could not keep the report' })
  }
})
