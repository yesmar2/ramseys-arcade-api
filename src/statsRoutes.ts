import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { namesOwnedByAccount } from './names.js'
import { isPlus } from './plans.js'
import { playerStats } from './stats.js'

export const statsRouter = Router()

/**
 * Your own numbers.
 *
 * Free gets the headline and the streak; Plus gets the depth. Sending the
 * headline to everyone is deliberate — a page that shows nothing until you pay
 * gives nobody a reason to.
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

  try {
    const stats = await playerStats(target)
    const plus = isPlus(account.plan)
    res.json({
      plan: account.plan,
      tag: target,
      tags: owned,
      stats: plus
        ? stats
        : // Free keeps what it can act on today, without the history.
          {
            headline: stats.headline,
            streak: { ...stats.streak, days: [] },
            games: [],
            nearRecords: [],
          },
      locked: !plus,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Could not load stats',
    })
  }
})
