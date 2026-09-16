import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { listNotifications, markRead, unreadCount } from './notifications.js'
import {
  disablePush,
  publicVapidKey,
  pushStatus,
  savePushSubscription,
} from './push.js'

export const notificationsRouter = Router()

async function requireAccount(
  req: import('express').Request,
  res: import('express').Response,
) {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' })
    return null
  }
  return account
}

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

notificationsRouter.get('/', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    const [items, unread] = await Promise.all([
      listNotifications(account.id),
      unreadCount(account.id),
    ])
    res.json({ notifications: items, unread })
  } catch (err) {
    fail(err, res)
  }
})

/** Cheap poll for the header badge — no payload, just the count. */
notificationsRouter.get('/unread', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    res.json({ unread: await unreadCount(account.id) })
  } catch (err) {
    fail(err, res)
  }
})

const readSchema = z.object({ ids: z.array(z.string().min(1)).max(100).optional() })

notificationsRouter.post('/read', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  const parsed = readSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  try {
    await markRead(account.id, parsed.data.ids)
    res.json({ unread: await unreadCount(account.id) })
  } catch (err) {
    fail(err, res)
  }
})

/* ---------------------------------------------------------------- push --- */

/** The browser needs this to build a subscription; it is public by design. */
notificationsRouter.get('/push/key', (_req, res) => {
  const key = publicVapidKey()
  if (!key) {
    res.status(503).json({ error: 'Push is not configured', code: 'PUSH_UNAVAILABLE' })
    return
  }
  res.json({ key })
})

notificationsRouter.get('/push', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  try {
    res.json(await pushStatus(account.id))
  } catch (err) {
    fail(err, res)
  }
})

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  timeZone: z.string().max(64).optional(),
})

notificationsRouter.post('/push', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  const parsed = subscribeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid subscription' })
    return
  }
  try {
    await savePushSubscription(account.id, parsed.data)
    res.json(await pushStatus(account.id))
  } catch (err) {
    fail(err, res)
  }
})

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2048).optional() })

notificationsRouter.delete('/push', async (req, res) => {
  const account = await requireAccount(req, res)
  if (!account) return
  const parsed = unsubscribeSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' })
    return
  }
  try {
    await disablePush(account.id, parsed.data.endpoint)
    res.json(await pushStatus(account.id))
  } catch (err) {
    fail(err, res)
  }
})
