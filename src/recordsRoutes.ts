import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { resolveBoardScope } from './groups.js'
import { assertCanUseName, withAvatarId, withAvatarIds } from './names.js'
import {
  addRecord,
  bestRecordForName,
  getRecordBoard,
  getRecordDef,
  listGameRecords,
} from './records.js'
import { isPeriod, resolveGameSlug, type Period } from './store.js'

export const recordsRouter = Router()

const submitSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().nonnegative().max(3_600_000),
  token: z.string().min(1).max(128).optional(),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
})

function parsePeriod(raw: unknown): Period {
  if (isPeriod(raw)) return raw
  return 'all'
}

async function boardAccess(req: import('express').Request) {
  const account = await accountFromRequest(req)
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const groupId = typeof req.query.group === 'string' ? req.query.group : undefined
  return resolveBoardScope(groupId, { accountId: account?.id, playerName })
}

function scopeError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

recordsRouter.get('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const period = parsePeriod(req.query.period)
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const { records } = await listGameRecords(game, period, Date.now(), scope)
  res.json({
    game,
    period,
    records,
  })
})

recordsRouter.get('/:game/:recordId', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  const recordId = req.params.recordId
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const def = getRecordDef(game, recordId)
  if (!def) {
    res.status(404).json({ error: 'Unknown record' })
    return
  }
  const period = parsePeriod(req.query.period)
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const you = name
    ? await bestRecordForName(game, recordId, name, period, Date.now(), scope)
    : null
  res.json({
    game,
    record: def,
    period,
    entries: await withAvatarIds(
      await getRecordBoard(game, recordId, period, Date.now(), scope),
    ),
    you: you ? await withAvatarId(you) : null,
  })
})

recordsRouter.post('/:game/:recordId', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  const recordId = req.params.recordId
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const def = getRecordDef(game, recordId)
  if (!def) {
    res.status(404).json({ error: 'Unknown record' })
    return
  }

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }

  const { name, score, token, device } = parsed.data
  const account = await accountFromRequest(req)

  let claim: { name: string; token: string }
  try {
    claim = await assertCanUseName(name, {
      claimToken: token,
      accountId: account?.id,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Name claim failed',
      code,
    })
    return
  }

  try {
    const result = await addRecord(game, recordId, claim.name, score, device ?? 'desktop')
    res.status(result.improved ? 201 : 200).json({
      game,
      record: def,
      improved: result.improved,
      entry: result.entry ? await withAvatarId(result.entry) : null,
      rank: result.rank,
      ranks: result.ranks,
      totalEntries: result.totalEntries,
      entries: await withAvatarIds(result.board),
      name: claim.name,
      token: claim.token,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Could not save record',
    })
  }
})
