import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { recordFeedback } from './feedback.js'
import { clientIp, takeToken } from './rateLimit.js'

export const feedbackRouter = Router()

const feedbackSchema = z.object({
  kind: z.enum(['idea', 'problem']),
  message: z.string().trim().min(1).max(2000),
  path: z.string().max(1000).optional(),
  /** The tag the sender plays under, when they have one. Only kept alongside a signed-in account. */
  name: z.string().max(24).optional(),
})

/** Per address, then for everyone together, so nobody can fill the table. */
const PER_IP = { limit: 6, windowMs: 60 * 60_000 }
const EVERYONE = { limit: 300, windowMs: 60 * 60_000 }

/** A player telling the arcade something. Anyone may, signed in or not. */
feedbackRouter.post('/', async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
    return
  }
  const gate = takeToken(`feedback:ip:${clientIp(req)}`, PER_IP)
  if (!gate.ok || !takeToken('feedback:all', EVERYONE).ok) {
    res.status(429).json({ error: 'That’s a lot of messages. Try again in a while.', code: 'RATE_LIMITED' })
    return
  }
  try {
    const account = await accountFromRequest(req)
    await recordFeedback(parsed.data, {
      accountId: account?.id ?? null,
      name: account ? (parsed.data.name ?? null) : null,
      userAgent: String(req.headers['user-agent'] ?? ''),
    })
    res.status(201).json({ kept: true })
  } catch (err) {
    console.warn('[feedback] could not keep a message:', err)
    res.status(500).json({ error: 'Could not keep the message' })
  }
})
