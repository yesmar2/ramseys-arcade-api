import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { createChallenge, getChallenge, isChallengeId, type ChallengeRow } from './challenges.js'
import { assertCanUseName, withAvatarId } from './names.js'
import { takeToken } from './rateLimit.js'
import { resolveGameSlug } from './store.js'

export const challengesRouter = Router()

/** A challenge a run is plenty; this only stops a script. */
const CREATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 }

const createSchema = z.object({
  game: z.string().min(1).max(32),
  /** The saved run to send: the id the score save returned. */
  scoreId: z.string().min(1).max(64),
  name: z.string().min(1).max(12),
  token: z.string().min(1).max(128).optional(),
})

async function publicChallenge(row: ChallengeRow) {
  const { id, game, name, score, createdAt, replyTo } = row
  return withAvatarId({ id, game, name, score, createdAt, replyTo })
}

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

/** Send a saved run as a challenge. Signed in, as the tag that ran it. */
challengesRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const game = resolveGameSlug(parsed.data.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to send a challenge', code: 'AUTH_REQUIRED' })
    return
  }
  const gate = takeToken(`challenge:account:${account.id}`, CREATE_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many challenges too quickly', code: 'RATE_LIMITED' })
    return
  }
  try {
    const claim = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account.id,
    })
    const row = await createChallenge({
      game,
      name: claim.name,
      accountId: account.id,
      scoreId: parsed.data.scoreId,
    })
    res.status(201).json(await publicChallenge(row))
  } catch (err) {
    fail(err, res)
  }
})

/** Read a challenge: what a friend's link opens. Anyone may. */
challengesRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id ?? '').trim()
  if (!isChallengeId(id)) {
    res.status(404).json({ error: 'No such challenge', code: 'CHALLENGE_NOT_FOUND' })
    return
  }
  try {
    const row = await getChallenge(id)
    if (!row) {
      res.status(404).json({ error: 'No such challenge', code: 'CHALLENGE_NOT_FOUND' })
      return
    }
    res.json(await publicChallenge(row))
  } catch (err) {
    fail(err, res)
  }
})
