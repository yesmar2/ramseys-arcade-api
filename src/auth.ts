import crypto from 'node:crypto'
import { and, eq, gt, lt, sql, type SQL } from 'drizzle-orm'
import type { Request } from 'express'
import { db } from './db/client.js'
import { accounts, emailCodes, magicLinks, sessions } from './db/schema.js'
import { dbTarget } from './env.js'
import { announce, onChange } from './feed.js'
import { mailerReady, sendMail } from './mailer.js'

export type AccountPlan = 'free' | 'plus'

export type Account = {
  id: string
  email: string
  createdAt: number
  plan: AccountPlan
  googleSub?: string
}

/**
 * A session lasts this long past the player's last visit: anyone who keeps coming back stays signed in,
 * and only someone away this long is signed out. Each visit moves the end on, at most once a day
 * (SESSION_RENEW_MS). It used to end 30 days after signing in whatever the player did, so an everyday
 * player was signed out mid-streak without a word.
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 days
const SESSION_RENEW_MS = 1000 * 60 * 60 * 24 // a day
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

async function accountWhere(where: SQL) {
  const rows = await db().select().from(accounts).where(where).limit(1)
  return rows[0] ?? null
}

/**
 * The account for an email, made the first time it's seen. Every way in lands here, so the same email
 * by Google, Discord or a code is the same player. A Google or Discord id, once known, wins over the
 * email: someone who changes their email there is still the same player here.
 */
async function getOrCreateAccount(
  emailRaw: string,
  opts: { googleSub?: string; discordId?: string } = {},
): Promise<Account> {
  const email = normalizeEmail(emailRaw)
  if (!email || !isValidEmail(email)) {
    throw Object.assign(new Error('Valid email required'), {
      status: 400,
      code: 'EMAIL_INVALID',
    })
  }

  const known = opts.googleSub
    ? await accountWhere(eq(accounts.googleSub, opts.googleSub))
    : opts.discordId
      ? await accountWhere(eq(accounts.discordId, opts.discordId))
      : null
  if (known) {
    // Their email there changed: follow it, unless another account here already has it.
    if (known.email !== email && !(await accountWhere(eq(accounts.email, email)))) {
      await db().update(accounts).set({ email }).where(eq(accounts.id, known.id))
      return rowToAccount({ ...known, email })
    }
    return rowToAccount(known)
  }

  const existing = await accountWhere(eq(accounts.email, email))
  if (existing) {
    // Known by email: remember this way in too.
    const link = {
      ...(opts.googleSub && !existing.googleSub ? { googleSub: opts.googleSub } : {}),
      ...(opts.discordId && !existing.discordId ? { discordId: opts.discordId } : {}),
    }
    if (Object.keys(link).length) {
      await db().update(accounts).set(link).where(eq(accounts.id, existing.id))
      return rowToAccount({ ...existing, ...link })
    }
    return rowToAccount(existing)
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
    discordId: opts.discordId ?? null,
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

/* ---------- a code by email ---------- */

/*
 * Six digits, sent to the address and typed back on the screen the player came from: a code rather than
 * a link, because a link opens in the mail app's own browser, which isn't where their run is waiting.
 * One code per address at a time. Each guess is spent before it's checked, so even guesses made at the
 * same moment can't get past the limit, and at the limit the code burns.
 */
const SITE_NAME = 'Blipka'
const CODE_TTL_MS = 1000 * 60 * 10 // 10 minutes
const CODE_TRIES = 5
/** How soon another code can go to the same address. The site counts it down. */
const CODE_RESEND_MS = 30_000

function hashCode(email: string, code: string) {
  return crypto.createHash('sha256').update(`${email}:${code}`).digest('base64url')
}

function authFailure(message: string, code: string, status = 400, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, code, ...extra })
}

/**
 * Can this server sign people in by email code? Where it can send mail, yes. Off production it
 * can anyway, handing the code back instead: local accounts are throwaway. Production without a mailer
 * says no, so the site doesn't offer it.
 */
export function emailCodesEnabled(): boolean {
  return mailerReady() || !dbTarget().isProduction
}

export async function emailSignInCode(emailRaw: string): Promise<{
  email: string
  expiresAt: number
  resendAt: number
  /** Off production only: the code itself, for local testing (there may be nothing to send it with). */
  devCode?: string
}> {
  const local = !dbTarget().isProduction
  if (!mailerReady() && !local) throw authFailure('Email sign-in isn’t available yet.', 'EMAIL_NOT_CONFIGURED', 503)
  const email = normalizeEmail(emailRaw)
  if (!email || !isValidEmail(email)) throw authFailure('Type a whole email address.', 'EMAIL_INVALID')
  const now = Date.now()
  const last = await db()
    .select({ sentAt: emailCodes.sentAt })
    .from(emailCodes)
    .where(eq(emailCodes.email, email))
    .limit(1)
  const sentAt = last[0]?.sentAt
  if (sentAt && now - sentAt < CODE_RESEND_MS) {
    throw authFailure('A code is on its way. Give it a few seconds.', 'CODE_WAIT', 429, {
      retryAfterMs: sentAt + CODE_RESEND_MS - now,
    })
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const row = { codeHash: hashCode(email, code), expiresAt: now + CODE_TTL_MS, attempts: 0, sentAt: now }
  await db().delete(emailCodes).where(lt(emailCodes.expiresAt, now))
  await db()
    .insert(emailCodes)
    .values({ email, ...row })
    .onConflictDoUpdate({ target: emailCodes.email, set: row })

  if (mailerReady()) {
    try {
      await sendMail(codeEmail(email, code))
    } catch (err) {
      // Not sent: nothing to wait for, so the next try can go straight away.
      await db().delete(emailCodes).where(and(eq(emailCodes.email, email), eq(emailCodes.sentAt, now)))
      throw err
    }
  } else {
    console.log(`[auth] sign-in code for ${email}: ${code}`)
  }
  return {
    email,
    expiresAt: row.expiresAt,
    resendAt: now + CODE_RESEND_MS,
    ...(local ? { devCode: code } : {}),
  }
}

function codeEmail(email: string, code: string) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
  return {
    to: email,
    subject: `${code} is your ${SITE_NAME} code`,
    text: [
      `Your ${SITE_NAME} sign-in code is ${spaced}.`,
      '',
      'Type it on the screen you came from. It lasts 10 minutes.',
      '',
      'If you didn’t ask for it, you can ignore this email: nobody gets in without the code.',
    ].join('\n'),
    html: `<div style="font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; color: #14212b">
<p style="margin: 0 0 16px; font-size: 16px">Your ${SITE_NAME} sign-in code:</p>
<p style="margin: 0 0 16px; font-size: 34px; font-weight: 700; letter-spacing: 6px; font-family: ui-monospace, Menlo, Consolas, monospace">${spaced}</p>
<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5">Type it on the screen you came from. It lasts 10 minutes.</p>
<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #5d6b75">If you didn’t ask for it, you can ignore this email: nobody gets in without the code.</p>
</div>`,
  }
}

export async function signInWithEmailCode(emailRaw: string, codeRaw: string): Promise<{
  sessionToken: string
  expiresAt: number
  account: Account
}> {
  const email = normalizeEmail(emailRaw)
  const code = codeRaw.replace(/\D/g, '')
  if (!email || !isValidEmail(email)) throw authFailure('Type a whole email address.', 'EMAIL_INVALID')
  if (code.length !== 6) throw authFailure('The code is six digits.', 'CODE_WRONG')

  const now = Date.now()
  const spent = await db()
    .update(emailCodes)
    .set({ attempts: sql`${emailCodes.attempts} + 1` })
    .where(and(eq(emailCodes.email, email), gt(emailCodes.expiresAt, now), lt(emailCodes.attempts, CODE_TRIES)))
    .returning({ codeHash: emailCodes.codeHash, attempts: emailCodes.attempts })
  const row = spent[0]
  if (!row) throw authFailure('That code has run out. Send a new one.', 'CODE_EXPIRED')

  const wanted = Buffer.from(row.codeHash)
  const given = Buffer.from(hashCode(email, code))
  if (wanted.length !== given.length || !crypto.timingSafeEqual(wanted, given)) {
    const left = CODE_TRIES - row.attempts
    if (left <= 0) {
      await db().delete(emailCodes).where(eq(emailCodes.email, email))
      throw authFailure('That’s not it, and that was the last try. Send a new code.', 'CODE_EXPIRED')
    }
    throw authFailure(`That’s not the code. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 'CODE_WRONG', 400, {
      triesLeft: left,
    })
  }

  // Used once: whichever request deletes it is the one signed in.
  const used = await db()
    .delete(emailCodes)
    .where(and(eq(emailCodes.email, email), eq(emailCodes.codeHash, row.codeHash)))
    .returning({ email: emailCodes.email })
  if (!used[0]) throw authFailure('That code has run out. Send a new one.', 'CODE_EXPIRED')

  const account = await getOrCreateAccount(email)
  const session = await createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}

/* ---------- Discord ---------- */

/*
 * The site sends the player to Discord, Discord sends them back to the site with a one-time code, and
 * the site hands that here. Trading it for who they are takes the client secret, which is why this half
 * lives on the server. Only a verified email signs in: the email is what makes them the same player as
 * any other way in.
 */
const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_TIMEOUT_MS = 10_000

export function getDiscordClientId(): string | null {
  return process.env.DISCORD_CLIENT_ID?.trim() || null
}

function discordSecret(): string | null {
  return process.env.DISCORD_CLIENT_SECRET?.trim() || null
}

export function discordEnabled(): boolean {
  return Boolean(getDiscordClientId() && discordSecret())
}

export async function signInWithDiscordCode(code: string, redirectUri: string): Promise<{
  sessionToken: string
  expiresAt: number
  account: Account
}> {
  const clientId = getDiscordClientId()
  const secret = discordSecret()
  if (!clientId || !secret) {
    throw authFailure('Discord sign-in isn’t available yet.', 'DISCORD_NOT_CONFIGURED', 503)
  }
  const refused = authFailure('Discord didn’t sign you in. Try again.', 'DISCORD_INVALID', 401)

  let accessToken: string
  try {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[auth] Discord token exchange answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
      throw refused
    }
    const body = (await res.json()) as { access_token?: unknown }
    if (typeof body.access_token !== 'string') throw refused
    accessToken = body.access_token
  } catch {
    throw refused
  }

  let me: { id?: unknown; email?: unknown; verified?: unknown }
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    })
    if (!res.ok) throw refused
    me = (await res.json()) as typeof me
  } catch {
    throw refused
  }
  if (typeof me.id !== 'string' || !me.id) throw refused
  if (typeof me.email !== 'string' || !me.email || me.verified !== true) {
    throw authFailure(
      'Your Discord account needs a verified email first. Verify it in Discord’s settings, or sign in another way.',
      'DISCORD_UNVERIFIED',
      401,
    )
  }

  const account = await getOrCreateAccount(me.email, { discordId: me.id })
  const session = await createSession(account.id)
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    account: publicAccount(account),
  }
}

/*
 * Nearly every request carries a session token, and looking it up is two
 * round trips before any work starts. Remember the answer for five minutes,
 * never past the session's own end; logging out drops it. The most recently
 * seen fifty thousand are kept: the cache used to be thrown away whole at
 * five thousand, sending every signed-in player's next request to the
 * database at once. Requests with the same token at the same moment share
 * one look-up. A session is kept under a hash of its token, which is what a
 * log-out tells the other servers, when there are more than one (feed.ts).
 */
const SESSION_CACHE_TTL_MS = 5 * 60_000
const SESSION_CACHE_MAX = 50_000
type SessionAnswer = { account: Account | null; expiresAt: number }
const sessionCache = new Map<string, SessionAnswer & { at: number }>()
const sessionLookups = new Map<string, Promise<SessionAnswer>>()
/** Moves on every log-out, so a look-up begun before one isn't kept after it. */
let sessionDrops = 0

function sessionKey(token: string) {
  return crypto.createHash('sha256').update(token).digest('base64url')
}

export function invalidateSessionCache(token?: string) {
  sessionDrops++
  if (token) sessionCache.delete(sessionKey(token))
  else sessionCache.clear()
}

onChange<{ key?: string }>('session-drop', ({ key }) => {
  sessionDrops++
  if (key) sessionCache.delete(String(key))
})

export async function resolveSession(
  sessionToken: string | null | undefined,
): Promise<Account | null> {
  if (!sessionToken) return null
  const key = sessionKey(sessionToken)
  const hit = sessionCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < SESSION_CACHE_TTL_MS && now < hit.expiresAt) {
    // Seen again: to the back of the line, which is the last to go.
    sessionCache.delete(key)
    sessionCache.set(key, hit)
    return hit.account
  }
  const dropsAtStart = sessionDrops
  let lookup = sessionLookups.get(sessionToken)
  if (!lookup) {
    lookup = resolveSessionFromDb(sessionToken).finally(() => sessionLookups.delete(sessionToken))
    sessionLookups.set(sessionToken, lookup)
  }
  const answer = await lookup
  if (dropsAtStart === sessionDrops) {
    sessionCache.delete(key)
    sessionCache.set(key, { ...answer, at: Date.now() })
    while (sessionCache.size > SESSION_CACHE_MAX) {
      sessionCache.delete(sessionCache.keys().next().value as string)
    }
  }
  return answer.account
}

async function resolveSessionFromDb(sessionToken: string): Promise<SessionAnswer> {
  const rows = await db()
    .select()
    .from(sessions)
    .where(eq(sessions.token, sessionToken))
    .limit(1)
  const session = rows[0]
  // No such session: an answer too, worth remembering for as long as any.
  if (!session) return { account: null, expiresAt: Number.POSITIVE_INFINITY }
  const now = Date.now()
  if (session.expiresAt < now) {
    await db().delete(sessions).where(eq(sessions.token, sessionToken))
    return { account: null, expiresAt: Number.POSITIVE_INFINITY }
  }
  // Back again: the session runs on from today. Moved at most once a day, so a busy player isn't a write a request.
  let expiresAt = session.expiresAt
  if (expiresAt - now < SESSION_TTL_MS - SESSION_RENEW_MS) {
    expiresAt = now + SESSION_TTL_MS
    await db().update(sessions).set({ expiresAt }).where(eq(sessions.token, sessionToken))
  }
  const account = await getAccount(session.accountId)
  return { account: account ? publicAccount(account) : null, expiresAt }
}

export async function logoutSession(sessionToken: string | null | undefined) {
  if (!sessionToken) return
  invalidateSessionCache(sessionToken)
  await db().delete(sessions).where(eq(sessions.token, sessionToken))
  await announce('session-drop', { key: sessionKey(sessionToken) })
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
