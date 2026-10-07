import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { paymentsEnabled, returnOrigin } from './payments.js'
import { confirmPlus, giveMembersLooks, looksAhead, memberNames, membersLooks, PLUS_PRICE, PLUS_YEAR, plusCheckout, plusPortal, plusState, TRIAL_DAYS } from './plus.js'
import { takeToken } from './rateLimit.js'

export const plusRouter = Router()

/** A checkout or a portal now and then is plenty: this only stops a script. */
const PAGE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

function fail(err: unknown, res: import('express').Response, fallback: string) {
  const status = (err as { status?: number }).status ?? 500
  if (status >= 500) console.warn('[plus]', err)
  res.status(status).json({ error: err instanceof Error ? err.message : fallback, code: (err as { code?: string }).code ?? 'PLUS_FAILED' })
}

/** GET /plus: Plus's price, whether it can be joined here yet, and, signed in, where you stand with it. */
plusRouter.get('/', async (req, res) => {
  try {
    const account = await accountFromRequest(req).catch(() => null)
    if (account) await giveMembersLooks(account.id, account.plan)
    res.json({
      price: PLUS_PRICE.amount,
      currency: PLUS_PRICE.currency,
      interval: PLUS_PRICE.interval,
      // Both ways to pay, and the free week a first membership starts with.
      prices: { month: PLUS_PRICE.amount, year: PLUS_YEAR.amount },
      trialDays: TRIAL_DAYS,
      buyable: paymentsEnabled(),
      // This month's members' looks, which every member has, and the looks to come, a month at a time.
      looks: membersLooks().map(({ id, name, what }) => ({ id, name, what })),
      ahead: looksAhead().map(({ month, id, name, what }) => ({ month, id, name, what })),
      you: account ? await plusState(account.id) : null,
    })
  } catch (err) {
    fail(err, res, 'Couldn’t read Plus')
  }
})

/** GET /plus/members: the tags of Plus members, for the mark the site shows beside their names. */
plusRouter.get('/members', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=120')
    res.json({ names: await memberNames() })
  } catch (err) {
    fail(err, res, 'Couldn’t read the members')
  }
})

/** POST /plus/checkout: Stripe's checkout for a Plus membership, by the month or the year ({ interval }), and its address. */
plusRouter.post('/checkout', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in to join Plus', code: 'AUTH_REQUIRED' })
      return
    }
    if (!takeToken(`plus:${account.id}`, PAGE_LIMIT).ok) {
      res.status(429).json({ error: 'Too many tries, give it a minute', code: 'RATE_LIMITED' })
      return
    }
    const parsed = z.object({ interval: z.enum(['month', 'year']).optional() }).safeParse(req.body ?? {})
    res.json({ url: await plusCheckout(account.id, returnOrigin(req), account.email, parsed.success ? parsed.data.interval : undefined) })
  } catch (err) {
    fail(err, res, 'Couldn’t open the payment page')
  }
})

/** POST /plus/confirm: back from Stripe, the checkout's subscription makes them a member now. */
plusRouter.post('/confirm', async (req, res) => {
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
    const member = await confirmPlus(parsed.data.session, account.id)
    res.json({ member, you: await plusState(account.id) })
  } catch (err) {
    fail(err, res, 'Couldn’t check that payment')
  }
})

/** POST /plus/manage: Stripe's customer portal, to change the card or cancel. Its address. */
plusRouter.post('/manage', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in first', code: 'AUTH_REQUIRED' })
      return
    }
    if (!takeToken(`plus:${account.id}`, PAGE_LIMIT).ok) {
      res.status(429).json({ error: 'Too many tries, give it a minute', code: 'RATE_LIMITED' })
      return
    }
    res.json({ url: await plusPortal(account.id, returnOrigin(req)) })
  } catch (err) {
    fail(err, res, 'Couldn’t open your membership')
  }
})
