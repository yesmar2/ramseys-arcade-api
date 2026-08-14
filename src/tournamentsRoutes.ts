import { Router } from 'express'
import { z } from 'zod'
import { claimName } from './names.js'
import { isAllowedGame } from './store.js'
import {
  activeTournamentsForGame,
  getTournamentDetail,
  joinTournament,
  listTournaments,
  renamePlayerAcrossTournaments,
  submitTournamentScore,
} from './tournaments.js'

export const tournamentsRouter = Router()

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()
const joinSchema = z.object({ name: nameSchema, token: tokenSchema })
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

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

tournamentsRouter.get('/', (_req, res) => {
  res.json({ tournaments: listTournaments() })
})

tournamentsRouter.post('/rename-player', (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    // Must own the old name; new name must be free or already owned
    claimName(parsed.data.from, parsed.data.fromToken)
    const toClaim = claimName(parsed.data.to, parsed.data.toToken)
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
  const detail = getTournamentDetail(req.params.id)
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
    const claim = claimName(parsed.data.name, parsed.data.token)
    const result = joinTournament(req.params.id, claim.name)
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
    const claim = claimName(parsed.data.name, parsed.data.token)
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
