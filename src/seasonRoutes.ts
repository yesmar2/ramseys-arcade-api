import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { nextLevelAt, rewardView, seasonInfo, seasonNow, syncSeason, type SeasonYou } from './seasons.js'

export const seasonRouter = Router()

/**
 * The season (seasons.ts): the live one, else the next to come, else the last; its pass's rewards, and,
 * for a player signed in to a live season, where they've got to. `catchup=1` (the Season page) also gives
 * any reward up to their level that a later release brought.
 */
seasonRouter.get('/', async (req, res) => {
  try {
    const now = Date.now()
    const season = await seasonNow(now)
    if (!season) {
      res.json({ season: null, rewards: [], you: null })
      return
    }
    let you: SeasonYou | null = null
    if (season.status === 'live') {
      const account = await accountFromRequest(req).catch(() => null)
      // A page asking gives the rewards, but leaves the level for the next run to announce (seasons.ts).
      const sync = account ? await syncSeason(account.id, now, { catchUp: req.query.catchup === '1', announce: false }) : null
      if (sync) you = { earned: sync.earned, level: sync.level, nextAt: nextLevelAt(season.def, sync.level) }
    }
    res.json({ season: seasonInfo(season, now), rewards: season.def.rewards.map(rewardView), you })
  } catch (err) {
    console.warn('[season]', err)
    res.status(500).json({ error: 'Couldn’t read the season', code: 'SEASON_FAILED' })
  }
})
