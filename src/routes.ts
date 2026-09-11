import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { resolveBoardScope } from './groups.js'
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

leaderboardsRouter.get('/bests', async (req, res) => {
  const name = String(req.query.name ?? '').trim()
  if (!name) {
    res.status(400).json({ error: 'name query param required' })
    return
  }
  const cleaned = name.slice(0, 12).toUpperCase()
  res.json({
    name: cleaned,
    bests: await bestsForName(name),
    avatarId: (await withAvatarId({ name: cleaned })).avatarId,
  })
})

leaderboardsRouter.get('/rank', async (req, res) => {
  const periodParam = req.query.period
  if (periodParam != null && periodParam !== '' && !isPeriod(periodParam)) {
    res.status(400).json({ error: 'Invalid period' })
    return
  }
  const period: Period = isPeriod(periodParam) ? periodParam : 'all'

  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }

  const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
  if (name) {
    const data = await rankForName(name, 2, period, Date.now(), scope)
    res.json({
      ...data,
      period,
      avatarId: (await withAvatarId({ name: name.slice(0, 12).toUpperCase() })).avatarId,
      nearby: await withAvatarIds(data.nearby),
    })
    return
  }
  const limitRaw = Number(req.query.limit ?? 50)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(100, Math.max(1, Math.floor(limitRaw)))
    : 50
  const all = await globalRanks(period, Date.now(), scope)
  res.json({
    period,
    totalPlayers: all.length,
    entries: await withAvatarIds(all.slice(0, limit)),
  })
})

leaderboardsRouter.get('/summary', async (req, res) => {
  const limitRaw = Number(req.query.limit ?? 3)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(10, Math.max(1, Math.floor(limitRaw)))
    : 3
  const period = parsePeriod(req.query.period)
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const boards = await boardsSummaryForPeriod(period, limit, Date.now(), scope)
  const games = await Promise.all(
    ALLOWED_GAMES.map(async (slug) => ({
      slug,
      entries: await withAvatarIds(boards[slug]),
    })),
  )
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

leaderboardsRouter.get('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
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
  const you = name ? await bestForName(game, name, period, Date.now(), scope) : null
  res.json({
    game,
    period,
    entries: await withAvatarIds(await getBoard(game, period, Date.now(), scope)),
    you: you ? await withAvatarId(you) : null,
  })
})

leaderboardsRouter.get('/:game/qualifies', async (req, res) => {
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
    const ok = await qualifies(game, score, periodParam)
    res.json({
      game,
      score,
      period: periodParam,
      qualifies: ok,
      rank: ok ? await rankForScore(game, score, periodParam) : null,
      ranks: await ranksForScore(game, score),
    })
    return
  }

  const ok = await qualifiesAny(game, score)
  const ranks = await ranksForScore(game, score)
  res.json({
    game,
    score,
    qualifies: ok,
    rank: ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null,
    ranks,
  })
})

leaderboardsRouter.post('/:game', async (req, res) => {
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
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to save a score', code: 'AUTH_REQUIRED' })
    return
  }

  let claim: { name: string; token: string }
  try {
    claim = await assertCanUseName(name, {
      claimToken: token,
      accountId: account.id,
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

  const result = await addScore(game, claim.name, score, device ?? 'desktop')
  res.status(201).json({
    game,
    entry: await withAvatarId(result.entry),
    rank: result.rank,
    ranks: result.ranks,
    previousBestRanks: result.previousBestRanks,
    bestRanks: result.bestRanks,
    period: 'daily',
    entries: await withAvatarIds(result.board),
    name: claim.name,
    token: claim.token,
  })
})
