import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { settleToday } from './today.js'

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
