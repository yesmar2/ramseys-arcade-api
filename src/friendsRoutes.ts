import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  removeFriend,
  sendFriendRequest,
} from './friends.js'

export const friendsRouter = Router()

const sendSchema = z.object({
  toName: z.string().min(1).max(12),
})

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

function requireAccount(req: import('express').Request, res: import('express').Response) {
  return accountFromRequest(req).then((account) => {
    if (!account) {
      res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' })
      return null
    }
    return account
  })
}

friendsRouter.get('/', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    const [friends, requests] = await Promise.all([
      listFriends(account.id),
      listFriendRequests(account.id),
    ])
    res.json({ friends, requests })
  } catch (err) {
    claimError(err, res)
  }
})

friendsRouter.post('/requests', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const result = await sendFriendRequest(account.id, parsed.data.toName)
    res.status(201).json(result)
  } catch (err) {
    claimError(err, res)
  }
})

friendsRouter.post('/requests/:id/accept', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    const result = await acceptFriendRequest(req.params.id, account.id)
    res.json(result)
  } catch (err) {
    claimError(err, res)
  }
})

friendsRouter.post('/requests/:id/decline', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    await declineFriendRequest(req.params.id, account.id)
    res.json({ ok: true })
  } catch (err) {
    claimError(err, res)
  }
})

friendsRouter.delete('/requests/:id', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    await cancelFriendRequest(req.params.id, account.id)
    res.json({ ok: true })
  } catch (err) {
    claimError(err, res)
  }
})

friendsRouter.delete('/:accountId', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    await removeFriend(account.id, req.params.accountId!)
    res.json({ ok: true })
  } catch (err) {
    claimError(err, res)
  }
})
