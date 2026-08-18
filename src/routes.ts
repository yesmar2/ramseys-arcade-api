import { Router } from 'express'
import { z } from 'zod'
import { claimName } from './names.js'
import {
  addScore,
  bestForName,
  bestsForName,
  getBoard,
  isAllowedGame,
  isPeriod,
  qualifies,
  qualifiesAny,
  rankForScore,
  ranksForScore,
  type Period,
} from './store.js'

export const leaderboardsRouter = Router()

leaderboardsRouter.get('/bests', (req, res) => {
  const name = String(req.query.name ?? '').trim()
  if (!name) {
    res.status(400).json({ error: 'name query param required' })
    return
  }
  res.json({
    name: name.slice(0, 12).toUpperCase(),
    bests: bestsForName(name),
  })
})

const submitSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().positive().max(1_000_000),
  token: z.string().min(1).max(128).optional(),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
})

function parsePeriod(raw: unknown): Period {
  if (isPeriod(raw)) return raw
  return 'all'
}

leaderboardsRouter.get('/:game', (req, res) => {
  const game = req.params.game
  if (!isAllowedGame(game)) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const period = parsePeriod(req.query.period)
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  res.json({
    game,
    period,
    entries: getBoard(game, period),
    you: name ? bestForName(game, name, period) : null,
  })
})

leaderboardsRouter.get('/:game/qualifies', (req, res) => {
  const game = req.params.game
  if (!isAllowedGame(game)) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const score = Number(req.query.score)
  if (!Number.isFinite(score)) {
    res.status(400).json({ error: 'score query param required' })
    return
  }

  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }

  if (isPeriod(periodParam)) {
    const ok = qualifies(game, score, periodParam)
    res.json({
      game,
      score,
      period: periodParam,
      qualifies: ok,
      rank: ok ? rankForScore(game, score, periodParam) : null,
      ranks: ranksForScore(game, score),
    })
    return
  }

  const ok = qualifiesAny(game, score)
  const ranks = ranksForScore(game, score)
  res.json({
    game,
    score,
    qualifies: ok,
    rank: ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null,
    ranks,
  })
})

leaderboardsRouter.post('/:game', (req, res) => {
  const game = req.params.game
  if (!isAllowedGame(game)) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }

  const { name, score, token, device } = parsed.data

  let claim: { name: string; token: string }
  try {
    claim = claimName(name, token)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Name claim failed',
      code,
    })
    return
  }

  const result = addScore(game, claim.name, score, device ?? 'desktop')
  res.status(201).json({
    game,
    entry: result.entry,
    rank: result.rank,
    ranks: result.ranks,
    period: 'daily',
    entries: result.board,
    name: claim.name,
    token: claim.token,
  })
})
