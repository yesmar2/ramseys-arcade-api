import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName } from './names.js'
import {
  acceptInvite,
  createDirectedInvite,
  declineInvite,
  listPendingInvites,
} from './invites.js'

export const invitesRouter = Router()

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()

const createSchema = z.object({
  kind: z.enum(['group', 'tournament']),
  targetId: z.string().min(1).max(80),
  toName: nameSchema,
  fromName: nameSchema.optional(),
})

const respondSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
})

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

invitesRouter.get('/', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    const playerName =
      typeof req.query.playerName === 'string' ? req.query.playerName : undefined
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending'
    if (status !== 'pending') {
      res.status(400).json({ error: 'Only status=pending is supported' })
      return
    }
    const invites = await listPendingInvites({
      playerName,
      accountId: account?.id,
    })
    res.json({ invites })
  } catch (err) {
    claimError(err, res)
  }
})

invitesRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to send invites' })
    return
  }
  try {
    const invite = await createDirectedInvite({
      kind: parsed.data.kind,
      targetId: parsed.data.targetId,
      toName: parsed.data.toName,
      fromAccountId: account.id,
      fromName: parsed.data.fromName,
    })
    res.status(201).json({ invite })
  } catch (err) {
    claimError(err, res)
  }
})

invitesRouter.post('/:id/accept', async (req, res) => {
  const parsed = respondSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = await accountFromRequest(req)
  try {
    const claimed = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const result = await acceptInvite(req.params.id, claimed.name, {
      accountId: account?.id,
      claimToken: claimed.token,
    })
    res.json({ ...result, name: claimed.name, token: claimed.token })
  } catch (err) {
    claimError(err, res)
  }
})

invitesRouter.post('/:id/decline', async (req, res) => {
  const parsed = respondSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = await accountFromRequest(req)
  try {
    const claimed = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const result = await declineInvite(req.params.id, claimed.name, {
      accountId: account?.id,
    })
    res.json(result)
  } catch (err) {
    claimError(err, res)
  }
})
