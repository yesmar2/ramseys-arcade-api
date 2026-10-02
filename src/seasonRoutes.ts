import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import {
  nextLevelAt,
  rewardView,
  seasonGoals,
  seasonInfo,
  seasonNow,
  seasonStandingsView,
  syncSeason,
  type SeasonGoalView,
  type SeasonStandingsView,
  type SeasonYou,
} from './seasons.js'

export const seasonRouter = Router()

/**
 * The season (seasons.ts): the live one, else the next to come, else the last; its pass's rewards, and,
 * for a player signed in to a live season, where they've got to. `catchup=1` (the Season page) also gives
 * any reward up to their level that a later release brought, and adds the standings and the goals, which
 * take more reading than the header's ring wants.
 */
seasonRouter.get('/', async (req, res) => {
  try {
    const now = Date.now()
    const season = await seasonNow(now)
    if (!season) {
      res.json({ season: null, rewards: [], you: null })
      return
    }
    const page = req.query.catchup === '1'
    const account = season.status !== 'upcoming' ? await accountFromRequest(req).catch(() => null) : null
    let you: SeasonYou | null = null
    let goals: SeasonGoalView[] | undefined
    if (account && season.status === 'live') {
      // A page asking gives the rewards, but leaves the level for the next run to announce (seasons.ts).
      const sync = await syncSeason(account.id, now, { catchUp: page, announce: false })
      if (sync) you = { earned: sync.earned, level: sync.level, nextAt: nextLevelAt(season.def, sync.level) }
      if (page) goals = await seasonGoals(account.id, season, now)
    }
    let standings: SeasonStandingsView | undefined
    if (page && season.status !== 'upcoming') standings = await seasonStandingsView(season, account?.id ?? null, now)
    res.json({
      season: seasonInfo(season, now),
      rewards: season.def.rewards.map(rewardView),
      you,
      ...(goals ? { goals } : {}),
      ...(standings ? { standings } : {}),
    })
  } catch (err) {
    console.warn('[season]', err)
    res.status(500).json({ error: 'Couldn’t read the season', code: 'SEASON_FAILED' })
  }
})
