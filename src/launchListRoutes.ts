import { Router } from 'express'
import { z } from 'zod'
import { joinLaunchList } from './launchList.js'
import { clientIp, takeToken } from './rateLimit.js'

export const launchListRouter = Router()

const joinSchema = z.object({
  email: z.string().trim().email().max(254),
  /** A box people never see (the page hides it): a bot that fills in every box fills this one too. */
  website: z.string().max(200).optional(),
})

/** Per address, then for everyone together, so nobody can fill the table. */
const PER_IP = { limit: 5, windowMs: 60 * 60_000 }
const EVERYONE = { limit: 600, windowMs: 60 * 60_000 }

/** The coming-soon page's "Tell me when it opens" (launchList.ts). Anyone may; signing up twice changes nothing. */
launchListRouter.post('/', async (req, res) => {
  const parsed = joinSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'That doesn’t look like an email address', code: 'INVALID_EMAIL' })
    return
  }
  const gate = takeToken(`launch:ip:${clientIp(req)}`, PER_IP)
  if (!gate.ok || !takeToken('launch:all', EVERYONE).ok) {
    res.status(429).json({ error: 'That’s a lot of tries. Try again in a while.', code: 'RATE_LIMITED' })
    return
  }
  // The bot is told it worked, and nothing is kept.
  if (parsed.data.website) {
    res.status(201).json({ kept: true })
    return
  }
  try {
    await joinLaunchList(parsed.data.email)
    res.status(201).json({ kept: true })
  } catch (err) {
    console.warn('[launch list] could not keep an address:', err)
    res.status(500).json({ error: 'Could not keep the address' })
  }
})
