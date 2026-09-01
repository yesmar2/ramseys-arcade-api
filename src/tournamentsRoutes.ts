import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName } from './names.js'
import { isAllowedGame } from './store.js'
import {
  activeTournamentsForGame,
  createTournament,
  getTournamentDetail,
  joinTournament,
  listTournaments,
  renamePlayerAcrossTournaments,
  submitTournamentScore,
  type CreateTournamentInput,
  type TournamentFormat,
  type TournamentListFilter,
} from './tournaments.js'

export const tournamentsRouter = Router()

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()
const joinSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
  playerId: z.string().min(1).max(64).optional(),
})
const scoreSchema = z.object({
  name: nameSchema,
  game: z.string().min(1),
  score: z.number().int().positive().max(1_000_000),
  token: tokenSchema,
})
const renameSchema = z.object({
  from: nameSchema,
  to: nameSchema,
  fromToken: tokenSchema,
  toToken: tokenSchema,
})

const communityFormats = ['open', 'attempt-limited', 'single-run', 'cumulative'] as const

const createSchema = z.object({
  title: z.string().min(3).max(60),
  blurb: z.string().max(280).optional(),
  game: z.string().min(1),
  format: z.enum(communityFormats),
  maxAttempts: z.number().int().min(2).max(20).optional(),
  durationHours: z.number().int().min(1).max(168),
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
  const raw = typeof req.query.source === 'string' ? req.query.source : 'all'
  const filter: TournamentListFilter =
    raw === 'official' || raw === 'community' ? raw : 'all'
  res.json({ tournaments: listTournaments(Date.now(), filter) })
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
  if (!isAllowedGame(parsed.data.game)) {
    res.status(400).json({ error: 'Unknown game' })
    return
  }
  try {
    const input: CreateTournamentInput = {
      title: parsed.data.title,
      blurb: parsed.data.blurb,
      game: parsed.data.game,
      format: parsed.data.format as Exclude<TournamentFormat, 'place-points'>,
      maxAttempts: parsed.data.maxAttempts,
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
  const game = req.params.game
  if (!isAllowedGame(game)) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  res.json({ game, tournaments: activeTournamentsForGame(game) })
})

tournamentsRouter.get('/:id', (req, res) => {
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const game = typeof req.query.game === 'string' ? req.query.game : undefined
  const detail = getTournamentDetail(req.params.id, Date.now(), { playerName, game })
  if (!detail) {
    res.status(404).json({ error: 'Tournament not found' })
    return
  }
  res.json(detail)
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
    const result = joinTournament(req.params.id, claim.name, Date.now(), parsed.data.playerId)
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
    )
    res.status(201).json({ ...result, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})
