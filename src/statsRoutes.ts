import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { namesOwnedByAccount } from './names.js'
import { playerStats } from './stats.js'
import { isPeriod, type Period } from './store.js'

export const statsRouter = Router()

/**
 * Your own numbers, all of them, on every plan.
 *
 * They were split between free and Plus; Plus is being redefined, and until it
 * is, a page that shows a player how they got here is worth more to the arcade
 * than a lock nobody can open. `locked` stays in the reply, always false, for
 * clients that still read it.
 */
statsRouter.get('/me', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' })
    return
  }

  const names = await namesOwnedByAccount(account.id)
  const name = typeof req.query.name === 'string' ? req.query.name.toUpperCase() : ''
  // Only your own tags: these are personal numbers, not a scouting report.
  const owned = names.map((n) => (typeof n === 'string' ? n : n.name))
  const target = owned.includes(name) ? name : owned[0]

  if (!target) {
    res.json({ plan: account.plan, stats: null, tags: owned })
    return
  }

  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }
  const period: Period = isPeriod(periodParam) ? periodParam : 'all'

  try {
    const stats = await playerStats(target, period)
    res.json({
      plan: account.plan,
      tag: target,
      tags: owned,
      period,
      stats,
      locked: false,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Could not load stats',
    })
  }
})
