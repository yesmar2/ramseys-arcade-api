import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName } from './names.js'
import { resolveGameSlug, type GameSlug } from './store.js'
import {
  activeTournamentsForGame,
  createTournament,
  getTournamentDetail,
  joinTournament,
  listTournaments,
  renamePlayerAcrossTournaments,
  submitTournamentScore,
  type CreateTournamentInput,
  type TournamentListFilter,
} from './tournaments.js'

export const tournamentsRouter = Router()

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()
const joinSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
  playerId: z.string().min(1).max(64).optional(),
  invite: z.string().min(4).max(16).optional(),
})
const scoreSchema = z.object({
  name: nameSchema,
  game: z.string().min(1),
  score: z.number().int().positive().max(1_000_000),
  token: tokenSchema,
  invite: z.string().min(4).max(16).optional(),
})
const renameSchema = z.object({
  from: nameSchema,
  to: nameSchema,
  fromToken: tokenSchema,
  toToken: tokenSchema,
})

const createSchema = z.object({
  title: z.string().min(3).max(60),
  blurb: z.string().max(280).optional(),
  games: z.array(z.string().min(1)).min(1).max(5),
  maxAttempts: z.number().int().min(0).max(99),
  maxPlayers: z.number().int().min(0).max(99),
  durationHours: z.number().int().min(0).max(168),
})

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

tournamentsRouter.get('/', (req, res) => {
  const account = accountFromRequest(req)
  const raw = typeof req.query.source === 'string' ? req.query.source : 'all'
  const filter: TournamentListFilter =
    raw === 'official' || raw === 'mine' || raw === 'joined' ? raw : 'all'
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  res.json({
    tournaments: listTournaments(Date.now(), filter, account?.id, playerName),
  })
})

tournamentsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to create events' })
    return
  }
  const games: GameSlug[] = []
  for (const game of parsed.data.games) {
    const slug = resolveGameSlug(game)
    if (!slug) {
      res.status(400).json({ error: 'Unknown game' })
      return
    }
    games.push(slug)
  }
  try {
    const input: CreateTournamentInput = {
      title: parsed.data.title,
      blurb: parsed.data.blurb,
      games,
      maxAttempts: parsed.data.maxAttempts,
      maxPlayers: parsed.data.maxPlayers,
      durationHours: parsed.data.durationHours,
    }
    const tournament = createTournament(input, {
      accountId: account.id,
      email: account.email,
    })
    res.status(201).json({ tournament })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/rename-player', (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    // Must own the old name; new name must be free or already owned
    assertCanUseName(parsed.data.from, {
      claimToken: parsed.data.fromToken,
      accountId: account?.id,
    })
    const toClaim = assertCanUseName(parsed.data.to, {
      claimToken: parsed.data.toToken,
      accountId: account?.id,
    })
    const result = renamePlayerAcrossTournaments(parsed.data.from, toClaim.name)
    res.json({ ...result, token: toClaim.token, name: toClaim.name })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.get('/active-for/:game', (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  res.json({ game, tournaments: activeTournamentsForGame(game) })
})

tournamentsRouter.get('/:id', (req, res) => {
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const game = typeof req.query.game === 'string' ? req.query.game : undefined
  const inviteCode = typeof req.query.invite === 'string' ? req.query.invite : undefined
  const account = accountFromRequest(req)
  try {
    const detail = getTournamentDetail(req.params.id, Date.now(), {
      playerName,
      game,
      inviteCode,
      accountId: account?.id,
    })
    if (!detail) {
      res.status(404).json({ error: 'Tournament not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/:id/join', (req, res) => {
  const parsed = joinSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    const claim = assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const result = joinTournament(
      req.params.id,
      claim.name,
      Date.now(),
      parsed.data.playerId,
      { inviteCode: parsed.data.invite, accountId: account?.id },
    )
    res.status(201).json({ ...result, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/:id/scores', (req, res) => {
  const parsed = scoreSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    const claim = assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const result = submitTournamentScore(
      req.params.id,
      claim.name,
      parsed.data.game,
      parsed.data.score,
      Date.now(),
      { inviteCode: parsed.data.invite, accountId: account?.id },
    )
    res.status(201).json({ ...result, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})
