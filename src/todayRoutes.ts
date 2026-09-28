import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { settleToday } from './today.js'
import { todayRivals } from './todayRivals.js'

export const todayRouter = Router()

/**
 * The signed-in account's Today set (today.ts): which of the day's three are done, their results, the
 * streak and the week. Asking settles any streak reward that's due, so a reward never waits on a save.
 */
todayRouter.get('/', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to keep a streak', code: 'AUTH_REQUIRED' })
    return
  }
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await settleToday(account.id))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }
})

/**
 * How the account's friends, or one of its groups (`?group=<id>`), are doing on today's three, beside the
 * account (todayRivals.ts). A group has to be one the account is in.
 */
todayRouter.get('/rivals', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to see your friends', code: 'AUTH_REQUIRED' })
    return
  }
  const group = typeof req.query.group === 'string' && req.query.group.trim() ? req.query.group.trim() : null
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await todayRivals(account.id, group))
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({ error: err instanceof Error ? err.message : 'Request failed', code })
  }
})
