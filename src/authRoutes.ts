import { Router } from 'express'
import { z } from 'zod'
import {
  accountFromRequest,
  bearerFromRequest,
  createMagicLink,
  discordEnabled,
  emailCodesEnabled,
  emailSignInCode,
  getDiscordClientId,
  getGoogleClientId,
  logoutSession,
  signInWithDiscordCode,
  signInWithEmailCode,
  signInWithGoogleIdToken,
  verifyMagicLink,
} from './auth.js'
import { dbTarget } from './env.js'
import { linkNameToAccount, namesOwnedByAccount } from './names.js'
import { planLimits } from './plans.js'
import { clientIp, takeToken, type Limit } from './rateLimit.js'
import { renamePlayerAcrossRecords } from './records.js'
import { renamePlayerAcrossLeaderboards } from './store.js'
import { renamePlayerAcrossTournaments } from './tournaments.js'

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
  previousName: z.string().min(1).max(12).optional(),
  previousToken: z.string().min(1).max(128).optional(),
})

const emailCodeSchema = z.object({
  email: z.string().min(3).max(254),
  code: z.string().min(1).max(16),
})

const discordSchema = z.object({
  code: z.string().min(1).max(512),
  redirectUri: z.string().min(1).max(512),
})

function authError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  const { retryAfterMs, triesLeft } = err as { retryAfterMs?: number; triesLeft?: number }
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(triesLeft !== undefined ? { triesLeft } : {}),
  })
}

/** The ways to sign in this server can do. The site offers exactly these. */
authRouter.get('/config', (_req, res) => {
  const googleClientId = getGoogleClientId()
  const discordClientId = discordEnabled() ? getDiscordClientId() : null
  res.json({
    googleClientId,
    googleEnabled: Boolean(googleClientId),
    discordClientId,
    discordEnabled: Boolean(discordClientId),
    emailEnabled: emailCodesEnabled(),
  })
})

/** Every limit here goes per address, and the code requests also per email and for everyone together. */
const LIMITS = {
  codeIp: { limit: 10, windowMs: 60 * 60_000 },
  codeEmail: { limit: 6, windowMs: 60 * 60_000 },
  // Every code sent is an email someone pays for; a flood stops here, not at the bill.
  codeAll: { limit: 300, windowMs: 60 * 60_000 },
  verifyIp: { limit: 30, windowMs: 10 * 60_000 },
  discordIp: { limit: 20, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>

function limited(res: import('express').Response, retryAfterMs: number) {
  res.status(429).json({
    error: 'That’s a lot of tries. Wait a few minutes, then try again.',
    code: 'RATE_LIMITED',
    retryAfterMs,
  })
}

/** A six-digit code to the address, to type back in (auth.ts). */
authRouter.post('/email-code', async (req, res) => {
  const parsed = emailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Type a whole email address.', code: 'EMAIL_INVALID' })
    return
  }
  const email = parsed.data.email.trim().toLowerCase()
  for (const [key, limit] of [
    [`code:ip:${clientIp(req)}`, LIMITS.codeIp],
    [`code:email:${email}`, LIMITS.codeEmail],
    ['code:all', LIMITS.codeAll],
  ] as const) {
    const gate = takeToken(key, limit)
    if (!gate.ok) {
      limited(res, gate.retryAfterMs)
      return
    }
  }
  try {
    res.json({ ok: true, ...(await emailSignInCode(email)) })
  } catch (err) {
    authError(err, res)
  }
})

authRouter.post('/email-code/verify', async (req, res) => {
  const parsed = emailCodeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'The code is six digits.', code: 'CODE_WRONG' })
    return
  }
  const gate = takeToken(`verify:ip:${clientIp(req)}`, LIMITS.verifyIp)
  if (!gate.ok) {
    limited(res, gate.retryAfterMs)
    return
  }
  try {
    const result = await signInWithEmailCode(parsed.data.email, parsed.data.code)
    res.json({
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
      account: result.account,
      names: await namesOwnedByAccount(result.account.id),
    })
  } catch (err) {
    authError(err, res)
  }
})

/**
 * Where Discord sends a player back to is the site's own /auth/discord page. Discord itself refuses
 * any address not registered with the app; this only keeps the obviously wrong out.
 */
function discordReturnLooksRight(uri: string): boolean {
  try {
    const url = new URL(uri)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return url.pathname === '/auth/discord' && !url.search && !url.hash && (url.protocol === 'https:' || local)
  } catch {
    return false
  }
}

authRouter.post('/discord', async (req, res) => {
  const parsed = discordSchema.safeParse(req.body)
  if (!parsed.success || !discordReturnLooksRight(parsed.data.redirectUri)) {
    res.status(400).json({ error: 'Discord didn’t sign you in. Try again.', code: 'DISCORD_INVALID' })
    return
  }
  const gate = takeToken(`discord:ip:${clientIp(req)}`, LIMITS.discordIp)
  if (!gate.ok) {
    limited(res, gate.retryAfterMs)
    return
  }
  try {
    const result = await signInWithDiscordCode(parsed.data.code, parsed.data.redirectUri)
    res.json({
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt,
      account: result.account,
      names: await namesOwnedByAccount(result.account.id),
    })
  } catch (err) {
    authError(err, res)
  }
})

/**
 * Is handing the magic-link token straight back to the caller allowed here?
 *
 * It is the whole sign-in. Returning it in the response means anyone who can
 * post an email address gets a session for that address — any address, whether
 * or not they have ever seen its inbox. Nothing here sends mail, so on a real
 * deployment the endpoint is not a way in for the owner of the account, only
 * for whoever asks first.
 *
 * It stays on for local work, where it is genuinely useful and the accounts
 * are throwaway. `dbTarget().isProduction` is the project's existing fail-safe
 * answer to "am I the real thing", and an unset NEON_BRANCH reads as
 * production, so forgetting to configure something leaves this closed.
 */
function magicLinkAllowed(): boolean {
  if (process.env.ALLOW_MAGIC_LINK === '1' || process.env.ALLOW_MAGIC_LINK === 'true') {
    return true
  }
  return !dbTarget().isProduction
}

authRouter.post('/magic-link', async (req, res) => {
  if (!magicLinkAllowed()) {
    res.status(503).json({
      error: 'Email sign-in is not available',
      code: 'MAGIC_LINK_DISABLED',
    })
    return
  }
  const parsed = emailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email required', code: 'EMAIL_INVALID' })
    return
  }
  try {
    const link = await createMagicLink(parsed.data.email)
    const frontend =
      process.env.FRONTEND_ORIGIN?.replace(/\/$/, '') || 'http://localhost:5173'
    const verifyUrl = `${frontend}${link.verifyPath}`
    console.log(`[auth] magic link for ${link.email}: ${verifyUrl}`)
    res.json({
      ok: true,
      email: link.email,
      expiresAt: link.expiresAt,
      // Only ever reaches a caller on a non-production branch, per above.
      verifyUrl,
      verifyToken: link.token,
    })
  } catch (err) {
    authError(err, res)
  }
})

authRouter.post('/verify', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Token required', code: 'TOKEN_REQUIRED' })
    return
  }
  try {
    const result = await verifyMagicLink(parsed.data.token)
    const names = await namesOwnedByAccount(result.account.id)
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
    const names = await namesOwnedByAccount(result.account.id)
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

authRouter.get('/me', async (req, res) => {
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' })
    return
  }
  res.json({
    account,
    names: await namesOwnedByAccount(account.id),
    // Sent so the client renders the real caps rather than its own copy.
    limits: planLimits(account.plan),
  })
})

authRouter.post('/logout', async (req, res) => {
  await logoutSession(bearerFromRequest(req))
  res.json({ ok: true })
})

authRouter.post('/link-name', async (req, res) => {
  const account = await accountFromRequest(req)
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
    const linked = await linkNameToAccount(
      parsed.data.name,
      parsed.data.claimToken,
      account.id,
      parsed.data.previousName,
      parsed.data.previousToken,
    )
    // Extra safety if link didn't migrate (idempotent if it did).
    for (const previous of linked.previousNames) {
      await renamePlayerAcrossLeaderboards(previous, linked.name)
      await renamePlayerAcrossTournaments(previous, linked.name)
      await renamePlayerAcrossRecords(previous, linked.name)
    }
    res.json({
      name: linked.name,
      token: linked.token,
      created: linked.created,
      previousNames: linked.previousNames,
      names: await namesOwnedByAccount(account.id),
    })
  } catch (err) {
    authError(err, res)
  }
})
