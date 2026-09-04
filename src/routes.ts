import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName, withAvatarId, withAvatarIds } from './names.js'
import {
  addScore,
  ALLOWED_GAMES,
  bestForName,
  bestsForName,
  boardsSummaryForPeriod,
  getBoard,
  globalRanks,
  isPeriod,
  qualifies,
  qualifiesAny,
  rankForName,
  rankForScore,
  ranksForScore,
  resolveGameSlug,
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
    avatarId: withAvatarId({ name: name.slice(0, 12).toUpperCase() }).avatarId,
  })
})

leaderboardsRouter.get('/rank', (req, res) => {
  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }
  const period: Period = isPeriod(periodParam) ? periodParam : 'all'

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
  if (name) {
    const data = rankForName(name, 2, period)
    res.json({
      ...data,
      period,
      avatarId: withAvatarId({ name: name.slice(0, 12).toUpperCase() }).avatarId,
      nearby: withAvatarIds(data.nearby),
    })
    return
  }
  const limitRaw = Number(req.query.limit ?? 50)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
    : 50
  const all = globalRanks(period)
  res.json({
    period,
    totalPlayers: all.length,
    entries: withAvatarIds(all.slice(0, limit)),
  })
})

leaderboardsRouter.get('/summary', (req, res) => {
  const limitRaw = Number(req.query.limit ?? 3)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(10, Math.max(1, Math.floor(limitRaw)))
    : 3
  const period = parsePeriod(req.query.period)
  const boards = boardsSummaryForPeriod(period, limit)
  const games = ALLOWED_GAMES.map((slug) => ({
    slug,
    entries: withAvatarIds(boards[slug]),
  }))
  res.json({ limit, period, games })
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
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const period = parsePeriod(req.query.period)
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  res.json({
    game,
    period,
    entries: withAvatarIds(getBoard(game, period)),
    you: name
      ? (() => {
          const you = bestForName(game, name, period)
          return you ? withAvatarId(you) : null
        })()
      : null,
  })
})

leaderboardsRouter.get('/:game/qualifies', (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
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
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
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

  const result = addScore(game, claim.name, score, device ?? 'desktop')
  res.status(201).json({
    game,
    entry: withAvatarId(result.entry),
    rank: result.rank,
    ranks: result.ranks,
    previousBestRanks: result.previousBestRanks,
    bestRanks: result.bestRanks,
    period: 'daily',
    entries: withAvatarIds(result.board),
    name: claim.name,
    token: claim.token,
  })
})
