import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import {
  assertCanUseName,
  cleanPlayerName,
  isNameAvailable,
  renameGamerTag,
  resolveAvatarId,
  setNameAvatar,
} from './names.js'
import { AVATAR_IDS } from './avatars.js'

export const namesRouter = Router()

const claimSchema = z.object({
  name: z.string().min(1).max(12),
  token: z.string().min(1).max(128).optional(),
})

const renameSchema = z.object({
  from: z.string().min(1).max(12),
  to: z.string().min(1).max(12),
  fromToken: z.string().min(1).max(128).optional(),
  toToken: z.string().min(1).max(128).optional(),
})

const avatarSchema = z.object({
  avatarId: z.string().min(1).max(32),
  token: z.string().min(1).max(128).optional(),
})

namesRouter.post('/rename', (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    const result = renameGamerTag(parsed.data.from, parsed.data.to, {
      fromToken: parsed.data.fromToken,
      claimToken: parsed.data.toToken,
      accountId: account?.id,
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Rename failed',
      code,
    })
  }
})

namesRouter.get('/:name', (req, res) => {
  const name = cleanPlayerName(req.params.name ?? '')
  if (!name) {
    res.status(400).json({ error: 'Name required' })
    return
  }
  const token = typeof req.query.token === 'string' ? req.query.token : null
  const account = accountFromRequest(req)
  res.json({
    name,
    available: isNameAvailable(name, token, account?.id),
    avatarId: resolveAvatarId(name),
    avatars: AVATAR_IDS,
  })
})

namesRouter.put('/:name/avatar', (req, res) => {
  const name = cleanPlayerName(req.params.name ?? '')
  if (!name) {
    res.status(400).json({ error: 'Name required' })
    return
  }
  const parsed = avatarSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    const result = setNameAvatar(name, parsed.data.avatarId, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Could not set avatar',
      code,
    })
  }
})

namesRouter.post('/claim', (req, res) => {
  const parsed = claimSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = accountFromRequest(req)
    const result = assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
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
