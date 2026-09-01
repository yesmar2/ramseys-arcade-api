import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName, withAvatarId, withAvatarIds } from './names.js'
import {
  addRecord,
  bestRecordForName,
  getRecordBoard,
  getRecordDef,
  listGameRecords,
} from './records.js'
import { isAllowedGame, isPeriod, type Period } from './store.js'

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

recordsRouter.get('/:game', (req, res) => {
  const game = req.params.game
  if (!isAllowedGame(game)) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const period = parsePeriod(req.query.period)
  const { records } = listGameRecords(game, period)
  res.json({
    game,
    period,
    records,
  })
})

recordsRouter.get('/:game/:recordId', (req, res) => {
  const game = req.params.game
  const recordId = req.params.recordId
  if (!isAllowedGame(game)) {
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
  res.json({
    game,
    record: def,
    period,
    entries: withAvatarIds(getRecordBoard(game, recordId, period)),
    you: name
      ? (() => {
          const you = bestRecordForName(game, recordId, name, period)
          return you ? withAvatarId(you) : null
        })()
      : null,
  })
})

recordsRouter.post('/:game/:recordId', (req, res) => {
  const game = req.params.game
  const recordId = req.params.recordId
  if (!isAllowedGame(game)) {
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
  const account = accountFromRequest(req)

  let claim: { name: string; token: string }
  try {
    claim = assertCanUseName(name, {
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
    const result = addRecord(game, recordId, claim.name, score, device ?? 'desktop')
    res.status(result.improved ? 201 : 200).json({
      game,
      record: def,
      improved: result.improved,
      entry: result.entry ? withAvatarId(result.entry) : null,
      rank: result.rank,
      ranks: result.ranks,
      totalEntries: result.totalEntries,
      entries: withAvatarIds(result.board),
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
