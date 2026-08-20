import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request } from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')

const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json')
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json')
const MAGIC_PATH = path.join(DATA_DIR, 'magic-links.json')

export type AccountPlan = 'free' | 'plus'

export type Account = {
  id: string
  email: string
  createdAt: number
  plan: AccountPlan
  googleSub?: string
}

type AccountsStore = { accounts: Record<string, Account> }
type SessionsStore = {
  sessions: Record<string, { accountId: string; expiresAt: number }>
}
type MagicStore = {
  links: Record<string, { email: string; expiresAt: number }>
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const MAGIC_TTL_MS = 1000 * 60 * 15 // 15 minutes

function mintToken() {
  return crypto.randomBytes(24).toString('base64url')
}

function mintId() {
  return crypto.randomBytes(12).toString('base64url')
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  ensureDataDir()
  if (!fs.existsSync(filePath)) {
    writeJson(filePath, fallback)
    return fallback
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, data: unknown) {
  ensureDataDir()
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, filePath)
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function accountsStore(): AccountsStore {
  const store = readJson<AccountsStore>(ACCOUNTS_PATH, { accounts: {} })
  if (!store.accounts || typeof store.accounts !== 'object') return { accounts: {} }
  return store
}

function sessionsStore(): SessionsStore {
  const store = readJson<SessionsStore>(SESSIONS_PATH, { sessions: {} })
  if (!store.sessions || typeof store.sessions !== 'object') return { sessions: {} }
  return store
}

function magicStore(): MagicStore {
  const store = readJson<MagicStore>(MAGIC_PATH, { links: {} })
  if (!store.links || typeof store.links !== 'object') return { links: {} }
  return store
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

function getOrCreateAccount(
  emailRaw: string,
  opts: { googleSub?: string } = {},
): Account {
  const email = normalizeEmail(emailRaw)
  if (!email || !isValidEmail(email)) {
    throw Object.assign(new Error('Valid email required'), {
      status: 400,
      code: 'EMAIL_INVALID',
    })
  }

  const store = accountsStore()
  if (opts.googleSub) {
    const byGoogle = Object.values(store.accounts).find(
      (a) => a.googleSub === opts.googleSub,
    )
    if (byGoogle) {
      if (byGoogle.email !== email) {
        byGoogle.email = email
        writeJson(ACCOUNTS_PATH, store)
      }
      return byGoogle
    }
  }

  const existing = Object.values(store.accounts).find((a) => a.email === email)
  if (existing) {
    if (opts.googleSub && !existing.googleSub) {
      existing.googleSub = opts.googleSub
      writeJson(ACCOUNTS_PATH, store)
    }
    return existing
  }

  const account: Account = {
    id: mintId(),
    email,
    createdAt: Date.now(),
    plan: 'free',
    ...(opts.googleSub ? { googleSub: opts.googleSub } : {}),
  }
  store.accounts[account.id] = account
  writeJson(ACCOUNTS_PATH, store)
  return account
}

export function getAccount(accountId: string): Account | null {
  return accountsStore().accounts[accountId] ?? null
}

export function createMagicLink(emailRaw: string): {
  email: string
  token: string
  expiresAt: number
  verifyPath: string
} {
  const account = getOrCreateAccount(emailRaw)
  const token = mintToken()
  const expiresAt = Date.now() + MAGIC_TTL_MS
  const store = magicStore()

  // Drop expired links
  for (const [k, v] of Object.entries(store.links)) {
    if (v.expiresAt < Date.now()) delete store.links[k]
  }

  store.links[token] = { email: account.email, expiresAt }
  writeJson(MAGIC_PATH, store)

  return {
    email: account.email,
    token,
    expiresAt,
    verifyPath: `/#/auth/verify/${token}`,
  }
}

function createSession(accountId: string): { token: string; expiresAt: number } {
  const token = mintToken()
  const expiresAt = Date.now() + SESSION_TTL_MS
  const store = sessionsStore()

  for (const [k, v] of Object.entries(store.sessions)) {
    if (v.expiresAt < Date.now()) delete store.sessions[k]
  }

  store.sessions[token] = { accountId, expiresAt }
  writeJson(SESSIONS_PATH, store)
  return { token, expiresAt }
}

export function verifyMagicLink(token: string): {
  sessionToken: string
  expiresAt: number
  account: Account
} {
  if (!token) {
    throw Object.assign(new Error('Token required'), {
      status: 400,
      code: 'TOKEN_REQUIRED',
    })
  }

  const store = magicStore()
  const link = store.links[token]
  if (!link) {
    throw Object.assign(new Error('Invalid or expired link'), {
      status: 400,
      code: 'MAGIC_INVALID',
    })
  }
  delete store.links[token]
  writeJson(MAGIC_PATH, store)

  if (link.expiresAt < Date.now()) {
    throw Object.assign(new Error('Invalid or expired link'), {
      status: 400,
      code: 'MAGIC_INVALID',
    })
  }

  const account = getOrCreateAccount(link.email)
  const session = createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}

export function resolveSession(sessionToken: string | null | undefined): Account | null {
  if (!sessionToken) return null
  const store = sessionsStore()
  const session = store.sessions[sessionToken]
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    delete store.sessions[sessionToken]
    writeJson(SESSIONS_PATH, store)
    return null
  }
  const account = getAccount(session.accountId)
  return account ? publicAccount(account) : null
}

export function logoutSession(sessionToken: string | null | undefined) {
  if (!sessionToken) return
  const store = sessionsStore()
  if (store.sessions[sessionToken]) {
    delete store.sessions[sessionToken]
    writeJson(SESSIONS_PATH, store)
  }
}

export function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

export function accountFromRequest(req: Request): Account | null {
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

  const account = getOrCreateAccount(email, { googleSub: sub })
  const session = createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}
