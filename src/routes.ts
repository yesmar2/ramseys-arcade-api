import { Router } from 'express'
import { z } from 'zod'
import {
  addScore,
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

const submitSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().positive().max(1_000_000),
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
  res.json({
    game,
    period,
    entries: getBoard(game, period),
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

  const { name, score } = parsed.data
  if (!qualifiesAny(game, score)) {
    res.status(409).json({
      error: 'Score does not qualify for the leaderboard',
      entries: getBoard(game, 'daily'),
    })
    return
  }

  const result = addScore(game, name, score)
  res.status(201).json({
    game,
    entry: result.entry,
    rank: result.rank,
    ranks: result.ranks,
    period: 'daily',
    entries: result.board,
  })
})
