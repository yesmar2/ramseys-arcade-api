import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { namesOwnedByAccount } from './names.js'
import { takeToken } from './rateLimit.js'
import { awardSecret, EGG_SECRETS, foundBefore, type SecretKey } from './secrets.js'

export const secretsRouter = Router()

/**
 * The secrets the account signed in has found, by number. The site's eggs ask it so that "found" is the
 * account's, not the device's: on a device shared by two accounts, each finds every egg for itself, and a
 * clue steps aside for an egg found on another device.
 */
secretsRouter.get('/found', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep a secret', code: 'AUTH_REQUIRED' })
    return
  }
  try {
    res.json({ found: [...(await foundBefore(account.id))].sort((a, b) => a - b) })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
})

/** A handful of eggs, found once each: this only stops a script. */
const FOUND_LIMIT = { limit: 10, windowMs: 60 * 1000 }

const foundSchema = z.object({ key: z.string().min(1).max(20) })

/**
 * The site found an easter egg that hides a secret (EGG_SECRETS): the cheat code, the blip, the barrel roll,
 * the bouncing blip's corner, an old cheat, a coin at Game Over, a balanced plate broken in Centroid, a game's own
 * egg, the admin page's Staff Only door. It goes
 * on the shelf of the tag the account plays as. `found` is null if it was found before, or there's no tag yet.
 */
secretsRouter.post('/found', async (req, res) => {
  const parsed = foundSchema.safeParse(req.body)
  const key = parsed.success ? (parsed.data.key as SecretKey) : null
  if (!key || !EGG_SECRETS.includes(key)) {
    res.status(400).json({ error: 'Not a secret the site can find', code: 'UNKNOWN_SECRET' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep a secret', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`secrets:account:${account.id}`, FOUND_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many secrets too quickly', code: 'RATE_LIMITED' })
    return
  }
  const [tag] = await namesOwnedByAccount(account.id)
  if (!tag) {
    res.json({ found: null, code: 'NO_TAG' })
    return
  }
  try {
    res.json({ found: await awardSecret({ accountId: account.id, name: tag.name, key, at: Date.now() }) })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
})
