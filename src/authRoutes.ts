import { Router } from 'express'
import { z } from 'zod'
import {
  accountFromRequest,
  bearerFromRequest,
  createMagicLink,
  getGoogleClientId,
  logoutSession,
  signInWithGoogleIdToken,
  verifyMagicLink,
} from './auth.js'
import { linkNameToAccount, namesOwnedByAccount } from './names.js'

export const authRouter = Router()

const emailSchema = z.object({
  email: z.string().email().max(254),
})

const verifySchema = z.object({
  token: z.string().min(1).max(128),
})

const googleSchema = z.object({
  idToken: z.string().min(1).max(8192),
})

const linkNameSchema = z.object({
  name: z.string().min(1).max(12),
  claimToken: z.string().min(1).max(128).optional(),
})

function authError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

authRouter.get('/config', (_req, res) => {
  const googleClientId = getGoogleClientId()
  res.json({
    googleClientId,
    googleEnabled: Boolean(googleClientId),
  })
})

authRouter.post('/magic-link', (req, res) => {
  const parsed = emailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email required', code: 'EMAIL_INVALID' })
    return
  }
  try {
    const link = createMagicLink(parsed.data.email)
    const frontend =
      process.env.FRONTEND_ORIGIN?.replace(/\/$/, '') || 'http://localhost:5173'
    const verifyUrl = `${frontend}${link.verifyPath}`
    console.log(`[auth] magic link for ${link.email}: ${verifyUrl}`)
    res.json({
      ok: true,
      email: link.email,
      expiresAt: link.expiresAt,
      // Dev convenience — omit in real email-only prod later
      verifyUrl,
      verifyToken: link.token,
    })
  } catch (err) {
    authError(err, res)
  }
})

authRouter.post('/verify', (req, res) => {
  const parsed = verifySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Token required', code: 'TOKEN_REQUIRED' })
    return
  }
  try {
    const result = verifyMagicLink(parsed.data.token)
    const names = namesOwnedByAccount(result.account.id)
    res.json({
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
      account: result.account,
      names,
    })
  } catch (err) {
    authError(err, res)
  }
})

authRouter.post('/google', async (req, res) => {
  const parsed = googleSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Google token required', code: 'TOKEN_REQUIRED' })
    return
  }
  try {
    const result = await signInWithGoogleIdToken(parsed.data.idToken)
    const names = namesOwnedByAccount(result.account.id)
    res.json({
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
      account: result.account,
      names,
    })
  } catch (err) {
    authError(err, res)
  }
})

authRouter.get('/me', (req, res) => {
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' })
    return
  }
  res.json({
    account,
    names: namesOwnedByAccount(account.id),
  })
})

authRouter.post('/logout', (req, res) => {
  logoutSession(bearerFromRequest(req))
  res.json({ ok: true })
})

authRouter.post('/link-name', (req, res) => {
  const account = accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' })
    return
  }
  const parsed = linkNameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const linked = linkNameToAccount(
      parsed.data.name,
      parsed.data.claimToken,
      account.id,
    )
    res.json({
      name: linked.name,
      token: linked.token,
      created: linked.created,
      names: namesOwnedByAccount(account.id),
    })
  } catch (err) {
    authError(err, res)
  }
})
