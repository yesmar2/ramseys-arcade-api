import { Router } from 'express'
import { cleanPlayerName } from './names.js'
import { ensurePeriodTrophies, recentTrophies, trophiesForName } from './trophies.js'

export const trophiesRouter = Router()

trophiesRouter.get('/', (req, res) => {
  ensurePeriodTrophies()
  const name = typeof req.query.name === 'string' ? cleanPlayerName(req.query.name) : ''
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  res.json({ trophies: trophiesForName(name) })
})

trophiesRouter.get('/recent', (req, res) => {
  ensurePeriodTrophies()
  const limit = Number(req.query.limit) || 20
  res.json({ trophies: recentTrophies(limit) })
})
