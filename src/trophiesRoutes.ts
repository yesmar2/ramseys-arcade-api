import { Router } from 'express'
import { cleanPlayerName } from './names.js'
import {
  ensurePeriodTrophies,
  recentTrophies,
  trophiesForName,
  trophySummariesForNames,
  trophySummaryForName,
} from './trophies.js'

export const trophiesRouter = Router()

trophiesRouter.get('/summary', (req, res) => {
  ensurePeriodTrophies()
  const name = typeof req.query.name === 'string' ? cleanPlayerName(req.query.name) : ''
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  res.json({ summary: trophySummaryForName(name) })
})

trophiesRouter.get('/counts', (req, res) => {
  ensurePeriodTrophies()
  const raw = typeof req.query.names === 'string' ? req.query.names : ''
  const names = raw
    .split(',')
    .map((n) => cleanPlayerName(n))
    .filter(Boolean)
    .slice(0, 100)
  if (!names.length) {
    res.status(400).json({ error: 'names required' })
    return
  }
  res.json({ counts: trophySummariesForNames(names) })
})

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
