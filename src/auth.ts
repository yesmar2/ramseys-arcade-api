import crypto from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Request } from 'express'
import { db } from './db/client.js'
import { accounts, magicLinks, sessions } from './db/schema.js'

export type AccountPlan = 'free' | 'plus'

export type Account = {
  id: string
  email: string
  createdAt: number
  plan: AccountPlan
  googleSub?: string
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const MAGIC_TTL_MS = 1000 * 60 * 15 // 15 minutes

function mintToken() {
  return crypto.randomBytes(24).toString('base64url')
}

function mintId() {
  return crypto.randomBytes(12).toString('base64url')
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function publicAccount(account: Account): Account {
  return {
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    plan: account.plan,
    ...(account.googleSub ? { googleSub: account.googleSub } : {}),
  }
}

function rowToAccount(row: {
  id: string
  email: string
  createdAt: number
  plan: string
  googleSub: string | null
}): Account {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt,
    plan: row.plan === 'plus' ? 'plus' : 'free',
    ...(row.googleSub ? { googleSub: row.googleSub } : {}),
  }
}

async function getOrCreateAccount(
  emailRaw: string,
  opts: { googleSub?: string } = {},
): Promise<Account> {
  const email = normalizeEmail(emailRaw)
  if (!email || !isValidEmail(email)) {
    throw Object.assign(new Error('Valid email required'), {
      status: 400,
      code: 'EMAIL_INVALID',
    })
  }

  if (opts.googleSub) {
    const byGoogle = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.googleSub, opts.googleSub))
      .limit(1)
    if (byGoogle[0]) {
      if (byGoogle[0].email !== email) {
        await db()
          .update(accounts)
          .set({ email })
          .where(eq(accounts.id, byGoogle[0].id))
        return rowToAccount({ ...byGoogle[0], email })
      }
      return rowToAccount(byGoogle[0])
    }
  }

  const existing = await db().select().from(accounts).where(eq(accounts.email, email)).limit(1)
  if (existing[0]) {
    if (opts.googleSub && !existing[0].googleSub) {
      await db()
        .update(accounts)
        .set({ googleSub: opts.googleSub })
        .where(eq(accounts.id, existing[0].id))
      return rowToAccount({ ...existing[0], googleSub: opts.googleSub })
    }
    return rowToAccount(existing[0])
  }

  const account: Account = {
    id: mintId(),
    email,
    createdAt: Date.now(),
    plan: 'free',
    ...(opts.googleSub ? { googleSub: opts.googleSub } : {}),
  }
  await db().insert(accounts).values({
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    plan: account.plan,
    googleSub: account.googleSub ?? null,
  })
  return account
}

export async function getAccount(accountId: string): Promise<Account | null> {
  const rows = await db().select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  return rows[0] ? rowToAccount(rows[0]) : null
}

export async function createMagicLink(emailRaw: string): Promise<{
  email: string
  token: string
  expiresAt: number
  verifyPath: string
}> {
  const account = await getOrCreateAccount(emailRaw)
  const token = mintToken()
  const expiresAt = Date.now() + MAGIC_TTL_MS

  await db().delete(magicLinks).where(lt(magicLinks.expiresAt, Date.now()))
  await db().insert(magicLinks).values({
    token,
    email: account.email,
    expiresAt,
  })

  return {
    email: account.email,
    token,
    expiresAt,
    verifyPath: `/#/auth/verify/${token}`,
  }
}

async function createSession(accountId: string): Promise<{ token: string; expiresAt: number }> {
  const token = mintToken()
  const expiresAt = Date.now() + SESSION_TTL_MS
  await db().delete(sessions).where(lt(sessions.expiresAt, Date.now()))
  await db().insert(sessions).values({ token, accountId, expiresAt })
  return { token, expiresAt }
}

export async function verifyMagicLink(token: string): Promise<{
  sessionToken: string
  expiresAt: number
  account: Account
}> {
  if (!token) {
    throw Object.assign(new Error('Token required'), {
      status: 400,
      code: 'TOKEN_REQUIRED',
    })
  }

  const rows = await db().select().from(magicLinks).where(eq(magicLinks.token, token)).limit(1)
  const link = rows[0]
  if (!link) {
    throw Object.assign(new Error('Invalid or expired link'), {
      status: 400,
      code: 'MAGIC_INVALID',
    })
  }
  await db().delete(magicLinks).where(eq(magicLinks.token, token))

  if (link.expiresAt < Date.now()) {
    throw Object.assign(new Error('Invalid or expired link'), {
      status: 400,
      code: 'MAGIC_INVALID',
    })
  }

  const account = await getOrCreateAccount(link.email)
  const session = await createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}

export async function resolveSession(
  sessionToken: string | null | undefined,
): Promise<Account | null> {
  if (!sessionToken) return null
  const rows = await db()
    .select()
    .from(sessions)
    .where(eq(sessions.token, sessionToken))
    .limit(1)
  const session = rows[0]
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    await db().delete(sessions).where(eq(sessions.token, sessionToken))
    return null
  }
  const account = await getAccount(session.accountId)
  return account ? publicAccount(account) : null
}

export async function logoutSession(sessionToken: string | null | undefined) {
  if (!sessionToken) return
  await db().delete(sessions).where(eq(sessions.token, sessionToken))
}

export function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

export async function accountFromRequest(req: Request): Promise<Account | null> {
  return resolveSession(bearerFromRequest(req))
}

export function getGoogleClientId(): string | null {
  const id = process.env.GOOGLE_CLIENT_ID?.trim()
  return id || null
}

/**
 * Verify a Google Identity Services ID token and create a session.
 */
export async function signInWithGoogleIdToken(idToken: string): Promise<{
  sessionToken: string
  expiresAt: number
  account: Account
}> {
  const clientId = getGoogleClientId()
  if (!clientId) {
    throw Object.assign(new Error('Google sign-in is not configured'), {
      status: 503,
      code: 'GOOGLE_NOT_CONFIGURED',
    })
  }
  if (!idToken) {
    throw Object.assign(new Error('Google token required'), {
      status: 400,
      code: 'TOKEN_REQUIRED',
    })
  }

  const { OAuth2Client } = await import('google-auth-library')
  const client = new OAuth2Client(clientId)
  let payload: {
    email?: string | null
    email_verified?: boolean | string
    sub?: string
  }
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId,
    })
    payload = ticket.getPayload() ?? {}
  } catch {
    throw Object.assign(new Error('Invalid Google sign-in'), {
      status: 401,
      code: 'GOOGLE_INVALID',
    })
  }

  const email = payload.email
  const sub = payload.sub
  const verified =
    payload.email_verified === true || payload.email_verified === 'true'
  if (!email || !sub || !verified) {
    throw Object.assign(new Error('Google account email is not verified'), {
      status: 401,
      code: 'GOOGLE_UNVERIFIED',
    })
  }

  const account = await getOrCreateAccount(email, { googleSub: sub })
  const session = await createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}
