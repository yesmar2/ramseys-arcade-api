import { Router } from 'express'
import { z } from 'zod'
import { claimName, cleanPlayerName, isNameAvailable } from './names.js'

export const namesRouter = Router()

const claimSchema = z.object({
  name: z.string().min(1).max(12),
  token: z.string().min(1).max(128).optional(),
})

namesRouter.get('/:name', (req, res) => {
  const name = cleanPlayerName(req.params.name ?? '')
  if (!name) {
    res.status(400).json({ error: 'Name required' })
    return
  }
  const token = typeof req.query.token === 'string' ? req.query.token : null
  res.json({
    name,
    available: isNameAvailable(name, token),
  })
})

namesRouter.post('/claim', (req, res) => {
  const parsed = claimSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const result = claimName(parsed.data.name, parsed.data.token)
    res.status(result.created ? 201 : 200).json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Claim failed',
      code,
    })
  }
})
