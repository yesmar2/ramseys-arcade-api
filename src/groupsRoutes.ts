import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { assertCanUseName } from './names.js'
import {
  createGroup,
  deleteGroup,
  getGroupDetail,
  joinGroup,
  kickMember,
  leaveGroup,
  listGroupsFor,
  renameGroup,
  rotateInvite,
} from './groups.js'

export const groupsRouter = Router()

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()

const createSchema = z.object({
  name: z.string().min(2).max(32),
  playerName: nameSchema.optional(),
})

const joinSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
  invite: z.string().min(4).max(16),
})

const leaveSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
})

const kickSchema = z.object({
  name: nameSchema,
})

const renameSchema = z.object({
  name: z.string().min(2).max(32),
})

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

function accessFromReq(req: import('express').Request) {
  const account = accountFromRequest(req)
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const inviteCode = typeof req.query.invite === 'string' ? req.query.invite : undefined
  return { account, playerName, inviteCode }
}

groupsRouter.get('/', (req, res) => {
  const { account, playerName } = accessFromReq(req)
  res.json({
    groups: listGroupsFor({ accountId: account?.id, playerName }),
  })
})

groupsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to create a group' })
    return
  }
  try {
    const group = createGroup(parsed.data.name, { accountId: account.id }, parsed.data.playerName)
    res.status(201).json({ group })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.get('/:id', (req, res) => {
  const { account, playerName, inviteCode } = accessFromReq(req)
  try {
    const group = getGroupDetail(req.params.id, {
      accountId: account?.id,
      playerName,
      inviteCode,
    })
    res.json({ group })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.post('/:id/join', (req, res) => {
  const parsed = joinSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  try {
    const claim = assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const group = joinGroup(req.params.id, claim.name, parsed.data.invite)
    res.json({ group, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.post('/:id/leave', (req, res) => {
  const parsed = leaveSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  try {
    assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account?.id,
    })
    const result = leaveGroup(req.params.id, parsed.data.name, account?.id)
    res.json(result)
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.post('/:id/kick', (req, res) => {
  const parsed = kickSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in as the owner' })
    return
  }
  try {
    const group = kickMember(req.params.id, account.id, parsed.data.name)
    res.json({ group })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.post('/:id/rename', (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in as the owner' })
    return
  }
  try {
    const group = renameGroup(req.params.id, account.id, parsed.data.name)
    res.json({ group })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.post('/:id/rotate-invite', (req, res) => {
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in as the owner' })
    return
  }
  try {
    const group = rotateInvite(req.params.id, account.id)
    res.json({ group })
  } catch (err) {
    claimError(err, res)
  }
})

groupsRouter.delete('/:id', (req, res) => {
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in as the owner' })
    return
  }
  try {
    const result = deleteGroup(req.params.id, account.id)
    res.json(result)
  } catch (err) {
    claimError(err, res)
  }
})
