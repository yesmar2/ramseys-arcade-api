import { Router } from 'express'
import { z } from 'zod'
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
const joinSchema = z.object({ name: nameSchema })
const scoreSchema = z.object({
  name: nameSchema,
  game: z.string().min(1),
  score: z.number().int().positive().max(1_000_000),
})
const renameSchema = z.object({
  from: nameSchema,
  to: nameSchema,
})

tournamentsRouter.get('/', (_req, res) => {
  res.json({ tournaments: listTournaments() })
})

tournamentsRouter.post('/rename-player', (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const result = renamePlayerAcrossTournaments(parsed.data.from, parsed.data.to)
  res.json(result)
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
    const result = joinTournament(req.params.id, parsed.data.name)
    res.status(201).json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: err instanceof Error ? err.message : 'Join failed' })
  }
})

tournamentsRouter.post('/:id/scores', (req, res) => {
  const parsed = scoreSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const { name, game, score } = parsed.data
    const result = submitTournamentScore(req.params.id, name, game, score)
    res.status(201).json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: err instanceof Error ? err.message : 'Submit failed' })
  }
})
