import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, whyNotAdmin } from './admin.js'
import { accountFromRequest } from './auth.js'
import { banName, listBans, purgeName, recentScores, unbanName, voidScores } from './bans.js'
import { listClientErrors } from './clientErrors.js'
import { listFeedback } from './feedback.js'
import { listFlags, reviewFlag, unreviewedCount } from './scoreFlags.js'
import { getClaim } from './names.js'
import { playerStats } from './playerStats.js'
import { setSiteEvents, siteEventsOn } from './siteEvents.js'
import { resolveGameSlug } from './store.js'
import { awardTickets } from './tickets.js'
import { grantFreeze, todayState } from './today.js'

export const adminRouter = Router()

/** Every route here is the same shape: prove admin, or the route does not exist. */
function refuse(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code ?? 'ERROR'
  res.status(status).json({ error: err instanceof Error ? err.message : 'Failed', code })
}

adminRouter.get('/whoami', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    const why = whyNotAdmin(account)
    // A 404, as every admin route answers a non-admin, but saying why: this is
    // the admin page asking about the one signed in, and "not found" alone left
    // an admin whose list was mistyped or never loaded nothing to go on.
    if (why || !account) {
      res.status(404).json({ error: why?.message ?? 'Not found', code: why?.code ?? 'NOT_FOUND' })
      return
    }
    res.json({ admin: true, email: account.email, unreviewedFlags: await unreviewedCount() })
  } catch (err) {
    refuse(err, res)
  }
})

/** What broke in players' browsers lately, the latest first. */
adminRouter.get('/client-errors', async (req, res) => {
  try {
    await requireAdmin(req)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    res.json({ errors: await listClientErrors(limit) })
  } catch (err) {
    refuse(err, res)
  }
})

/** Who's playing: active players, new accounts, return rates, runs begun (playerStats.ts). `seeded=1` counts the seeded world too. */
adminRouter.get('/players', async (req, res) => {
  try {
    await requireAdmin(req)
    res.json(await playerStats(Date.now(), req.query.seeded === '1'))
  } catch (err) {
    refuse(err, res)
  }
})

/** Whether the arcade's own events run: the daily event, the One Shot and the Weekly Triple (siteEvents.ts). */
adminRouter.get('/site-events', async (req, res) => {
  try {
    await requireAdmin(req)
    res.json({ on: await siteEventsOn() })
  } catch (err) {
    refuse(err, res)
  }
})

adminRouter.post('/site-events', async (req, res) => {
  try {
    await requireAdmin(req)
    const parsed = z.object({ on: z.boolean() }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
      return
    }
    res.json({ on: await setSiteEvents(parsed.data.on) })
  } catch (err) {
    refuse(err, res)
  }
})

const freezeSchema = z.object({ name: z.string().min(1).max(12) })

/**
 * A Dailies streak freeze for a tag's account, from an admin (today.ts grantFreeze): held from today, within
 * the 2 a player can hold. To put right a streak lost to something that wasn't the player's doing.
 */
adminRouter.post('/freezes/grant', async (req, res) => {
  try {
    await requireAdmin(req)
    const parsed = freezeSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
      return
    }
    const claim = await getClaim(parsed.data.name.trim().toUpperCase())
    if (!claim?.accountId) {
      res.status(404).json({ error: 'That tag has no account', code: 'NO_ACCOUNT' })
      return
    }
    await grantFreeze(claim.accountId)
    res.json({ name: parsed.data.name.trim().toUpperCase(), freezes: (await todayState(claim.accountId)).freezes })
  } catch (err) {
    refuse(err, res)
  }
})

const grantSchema = z.object({ name: z.string().min(1).max(12), amount: z.number().int().min(1).max(50_000) })

/**
 * Tickets for a tag's account, from an admin: to try the prize counter without
 * earning them first, or to put right a payout that went wrong.
 */
adminRouter.post('/tickets/grant', async (req, res) => {
  try {
    await requireAdmin(req)
    const parsed = grantSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' })
      return
    }
    const claim = await getClaim(parsed.data.name.trim().toUpperCase())
    if (!claim?.accountId) {
      res.status(404).json({ error: 'That tag has no account', code: 'NO_ACCOUNT' })
      return
    }
    const now = Date.now()
    const paid = await awardTickets(claim.accountId, 'grant', `grant-${now}`, parsed.data.amount, null, now)
    res.json({ name: parsed.data.name.trim().toUpperCase(), ...paid })
  } catch (err) {
    refuse(err, res)
  }
})

/** What players have told the arcade from its Tell us panel, the latest first. */
adminRouter.get('/feedback', async (req, res) => {
  try {
    await requireAdmin(req)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    res.json({ feedback: await listFeedback(limit) })
  } catch (err) {
    refuse(err, res)
  }
})

/** Scores that looked wrong on the way in and nobody has settled yet. */
adminRouter.get('/flags', async (req, res) => {
  try {
    await requireAdmin(req)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const includeReviewed = req.query.all === '1' || req.query.all === 'true'
    res.json({ flags: await listFlags({ limit, includeReviewed }) })
  } catch (err) {
    refuse(err, res)
  }
})

/** Settle a flag, whichever way it went — the score itself is voided separately. */
adminRouter.post('/flags/:id/review', async (req, res) => {
  try {
    const account = await requireAdmin(req)
    const done = await reviewFlag(req.params.id)
    if (!done) {
      res.status(404).json({ error: 'No such open flag', code: 'NOT_FOUND' })
      return
    }
    console.log(`[admin] ${account.email} reviewed flag ${req.params.id}`)
    res.json({ reviewed: true })
  } catch (err) {
    refuse(err, res)
  }
})

/** Recent scores with their audit trail — the "is this real?" view. */
adminRouter.get('/scores', async (req, res) => {
  try {
    await requireAdmin(req)
    const game = typeof req.query.game === 'string' ? resolveGameSlug(req.query.game) : null
    const name = typeof req.query.name === 'string' ? req.query.name : undefined
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
    const scores = await recentScores({ game: game ?? undefined, name, limit })
    res.json({ scores })
  } catch (err) {
    refuse(err, res)
  }
})

const voidSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) })

/** Take scores off the boards. */
adminRouter.post('/scores/void', async (req, res) => {
  try {
    const account = await requireAdmin(req)
    const parsed = voidSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'ids required', code: 'INVALID_BODY' })
      return
    }
    const removed = await voidScores(parsed.data.ids)
    console.log(`[admin] ${account.email} voided ${removed} score(s)`)
    res.json({ voided: removed })
  } catch (err) {
    refuse(err, res)
  }
})

const banSchema = z.object({
  name: z.string().min(1).max(12),
  reason: z.string().max(500).optional(),
  /** Also wipe everything the tag has already posted. */
  purge: z.boolean().optional(),
})

adminRouter.get('/bans', async (req, res) => {
  try {
    await requireAdmin(req)
    res.json({ bans: await listBans() })
  } catch (err) {
    refuse(err, res)
  }
})

adminRouter.post('/bans', async (req, res) => {
  try {
    const account = await requireAdmin(req)
    const parsed = banSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'name required', code: 'INVALID_BODY' })
      return
    }
    const ban = await banName(parsed.data.name, {
      reason: parsed.data.reason,
      bannedBy: account.email,
    })
    const purged = parsed.data.purge ? await purgeName(ban.name) : null
    console.log(
      `[admin] ${account.email} banned ${ban.name}${purged ? ` and purged ${purged.leaderboard} score(s)` : ''}`,
    )
    res.status(201).json({ ban, purged })
  } catch (err) {
    refuse(err, res)
  }
})

adminRouter.delete('/bans/:name', async (req, res) => {
  try {
    const account = await requireAdmin(req)
    const lifted = await unbanName(req.params.name)
    if (!lifted) {
      res.status(404).json({ error: 'No such ban', code: 'NOT_FOUND' })
      return
    }
    console.log(`[admin] ${account.email} lifted the ban on ${req.params.name.toUpperCase()}`)
    res.json({ lifted: true })
  } catch (err) {
    refuse(err, res)
  }
})
