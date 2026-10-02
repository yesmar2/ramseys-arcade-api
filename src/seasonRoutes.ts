import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { confirmCheckout, paymentsEnabled, plusCheckout, returnOrigin } from './payments.js'
import { takeToken } from './rateLimit.js'
import {
  hasPlus,
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
    let plus = false
    if (account && season.status === 'live') {
      // A page asking gives the rewards, but leaves the level for the next run to announce (seasons.ts).
      const sync = await syncSeason(account.id, now, { catchUp: page, announce: false })
      if (sync) {
        you = { earned: sync.earned, level: sync.level, nextAt: nextLevelAt(season.def, sync.level) }
        plus = sync.plus
      }
      if (page) goals = await seasonGoals(account.id, season, now)
    } else if (account && season.def.plus) {
      plus = await hasPlus(account.id, season.def.id)
    }
    let standings: SeasonStandingsView | undefined
    if (page && season.status !== 'upcoming') standings = await seasonStandingsView(season, account?.id ?? null, now)
    res.json({
      season: seasonInfo(season, now),
      rewards: season.def.rewards.map(rewardView),
      // The Pass+ row, its price, whether this player has it, and whether it can be bought here yet.
      plus: season.def.plus
        ? {
            price: season.def.plus.price,
            currency: season.def.plus.currency,
            rewards: season.def.plus.rewards.map(rewardView),
            owned: plus,
            buyable: paymentsEnabled() && season.status === 'live',
          }
        : null,
      you,
      ...(goals ? { goals } : {}),
      ...(standings ? { standings } : {}),
    })
  } catch (err) {
    console.warn('[season]', err)
    res.status(500).json({ error: 'Couldn’t read the season', code: 'SEASON_FAILED' })
  }
})

/** A checkout now and then is plenty: this only stops a script. */
const CHECKOUT_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

/** POST /season/plus/checkout: a Stripe Checkout for the live season's Pass+ (payments.ts), and its address. */
seasonRouter.post('/plus/checkout', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in to get Pass+', code: 'AUTH_REQUIRED' })
      return
    }
    const gate = takeToken(`checkout:${account.id}`, CHECKOUT_LIMIT)
    if (!gate.ok) {
      res.status(429).json({ error: 'Too many tries, give it a minute', code: 'RATE_LIMITED' })
      return
    }
    const season = await seasonNow()
    if (!season || season.status !== 'live' || !season.def.plus) {
      res.status(409).json({ error: 'There’s no season to buy Pass+ for right now', code: 'NO_SEASON' })
      return
    }
    if (await hasPlus(account.id, season.def.id)) {
      res.status(409).json({ error: 'You have Pass+ for this season already', code: 'ALREADY_PLUS' })
      return
    }
    const url = await plusCheckout(season.def, account.id, returnOrigin(req), account.email)
    res.json({ url })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status >= 500) console.warn('[season] checkout', err)
    res.status(status).json({ error: err instanceof Error ? err.message : 'Couldn’t open the payment page', code: (err as { code?: string }).code ?? 'CHECKOUT_FAILED' })
  }
})

/** POST /season/plus/confirm: back from Stripe, a paid checkout gives Pass+ now, in case its webhook is slower. */
seasonRouter.post('/plus/confirm', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in first', code: 'AUTH_REQUIRED' })
      return
    }
    const parsed = z.object({ session: z.string().min(1).max(200) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
      return
    }
    const paid = await confirmCheckout(parsed.data.session, account.id)
    res.json({ paid })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: err instanceof Error ? err.message : 'Couldn’t check that payment', code: (err as { code?: string }).code ?? 'CONFIRM_FAILED' })
  }
})
