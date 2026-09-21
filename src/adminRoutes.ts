import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from './admin.js'
import { banName, listBans, purgeName, recentScores, unbanName, voidScores } from './bans.js'
import { resolveGameSlug } from './store.js'

export const adminRouter = Router()

/** Every route here is the same shape: prove admin, or the route does not exist. */
function refuse(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code ?? 'ERROR'
  res.status(status).json({ error: err instanceof Error ? err.message : 'Failed', code })
}

adminRouter.get('/whoami', async (req, res) => {
  try {
    const account = await requireAdmin(req)
    res.json({ admin: true, email: account.email })
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
