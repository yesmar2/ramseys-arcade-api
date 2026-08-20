import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const CLAIMS_PATH = path.join(DATA_DIR, 'name-claims.json')

export type NameClaim = {
  token: string
  claimedAt: number
  accountId?: string
}

type ClaimsStore = {
  claims: Record<string, NameClaim>
}

function emptyStore(): ClaimsStore {
  return { claims: {} }
}

function ensureStore(): ClaimsStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!fs.existsSync(CLAIMS_PATH)) {
    const empty = emptyStore()
    fs.writeFileSync(CLAIMS_PATH, JSON.stringify(empty, null, 2))
    return empty
  }
  try {
    const raw = fs.readFileSync(CLAIMS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as ClaimsStore
    if (!parsed || typeof parsed.claims !== 'object' || parsed.claims == null) {
      return emptyStore()
    }
    return { claims: parsed.claims }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: ClaimsStore) {
  const tmp = `${CLAIMS_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, CLAIMS_PATH)
}

export function cleanPlayerName(name: string) {
  return name.trim().slice(0, 12).toUpperCase()
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url')
}

export function getClaim(name: string): NameClaim | null {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return null
  return ensureStore().claims[cleaned] ?? null
}

export function isNameAvailable(
  name: string,
  token?: string | null,
  accountId?: string | null,
): boolean {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return false
  const claim = getClaim(cleaned)
  if (!claim) return true
  if (token && token === claim.token) return true
  if (accountId && claim.accountId === accountId) return true
  return false
}

export type UseNameAuth = {
  claimToken?: string | null
  accountId?: string | null
}

/**
 * Claim a player name (or verify an existing claim).
 * Accepts guest claim token and/or owning account id.
 */
export function claimName(
  name: string,
  token?: string | null,
  accountId?: string | null,
): { name: string; token: string; created: boolean } {
  return assertCanUseName(name, { claimToken: token, accountId })
}

function releaseOtherAccountNames(
  store: ClaimsStore,
  accountId: string,
  keepName: string,
) {
  for (const [otherName, claim] of Object.entries(store.claims)) {
    if (otherName === keepName) continue
    if (claim.accountId === accountId) {
      delete claim.accountId
      claim.token = mintToken()
    }
  }
}

/**
 * Authorize use of a name via guest token or owning session account.
 * Creates the claim if the name is free.
 */
export function assertCanUseName(
  name: string,
  auth: UseNameAuth = {},
): { name: string; token: string; created: boolean } {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }

  const store = ensureStore()
  const existing = store.claims[cleaned]
  const { claimToken, accountId } = auth

  if (!existing) {
    const next: NameClaim = { token: mintToken(), claimedAt: Date.now() }
    if (accountId) {
      next.accountId = accountId
      releaseOtherAccountNames(store, accountId, cleaned)
    }
    store.claims[cleaned] = next
    writeStore(store)
    return { name: cleaned, token: next.token, created: true }
  }

  const tokenOk = Boolean(claimToken && claimToken === existing.token)
  const accountOk = Boolean(accountId && existing.accountId === accountId)

  if (tokenOk || accountOk) {
    let dirty = false
    if (accountId && tokenOk && !existing.accountId) {
      existing.accountId = accountId
      releaseOtherAccountNames(store, accountId, cleaned)
      dirty = true
    }
    if (dirty) writeStore(store)
    return { name: cleaned, token: existing.token, created: false }
  }

  throw Object.assign(new Error('That name is already taken'), {
    status: 409,
    code: 'NAME_TAKEN',
  })
}

/** Verify ownership without creating a new claim. */
export function assertOwnsName(
  name: string,
  token?: string | null,
  accountId?: string | null,
): string {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }
  const existing = getClaim(cleaned)
  if (!existing) {
    throw Object.assign(new Error('Name is not claimed'), {
      status: 409,
      code: 'NAME_UNCLAIMED',
    })
  }
  const tokenOk = Boolean(token && token === existing.token)
  const accountOk = Boolean(accountId && existing.accountId === accountId)
  if (!tokenOk && !accountOk) {
    throw Object.assign(new Error('That name is already taken'), {
      status: 409,
      code: 'NAME_TAKEN',
    })
  }
  return cleaned
}

/**
 * Bind a name to an account as its only active gamer tag.
 * Any previously linked tags for this account are released (and their
 * claim tokens rotated so other devices cannot keep using them).
 */
export function linkNameToAccount(
  name: string,
  claimToken: string | null | undefined,
  accountId: string,
): { name: string; token: string; created: boolean } {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }
  if (!accountId) {
    throw Object.assign(new Error('Account required'), { status: 401, code: 'AUTH_REQUIRED' })
  }

  const store = ensureStore()
  const existing = store.claims[cleaned]
  let created = false
  let token: string

  if (!existing) {
    token = mintToken()
    store.claims[cleaned] = {
      token,
      claimedAt: Date.now(),
      accountId,
    }
    created = true
  } else if (existing.accountId && existing.accountId !== accountId) {
    throw Object.assign(new Error('That name is linked to another account'), {
      status: 409,
      code: 'NAME_TAKEN',
    })
  } else if (existing.accountId === accountId) {
    token = existing.token
  } else if (claimToken && claimToken === existing.token) {
    existing.accountId = accountId
    token = existing.token
  } else {
    throw Object.assign(
      new Error('Sign in from the device that claimed this name, then link it'),
      { status: 403, code: 'NAME_PROOF_REQUIRED' },
    )
  }

  // One active tag per account: release everything else.
  releaseOtherAccountNames(store, accountId, cleaned)

  writeStore(store)
  return { name: cleaned, token, created }
}

/** Heal accounts that somehow own multiple tags; keep the newest. */
export function reconcileAccountNames(accountId: string): { name: string; token: string }[] {
  if (!accountId) return []
  const store = ensureStore()
  const owned: { name: string; token: string; claimedAt: number }[] = []
  for (const [name, claim] of Object.entries(store.claims)) {
    if (claim.accountId === accountId) {
      owned.push({ name, token: claim.token, claimedAt: claim.claimedAt })
    }
  }
  if (owned.length <= 1) {
    return owned.map(({ name, token }) => ({ name, token }))
  }

  owned.sort((a, b) => b.claimedAt - a.claimedAt)
  const keep = owned[0]
  for (const extra of owned.slice(1)) {
    const claim = store.claims[extra.name]
    if (!claim) continue
    delete claim.accountId
    claim.token = mintToken()
  }
  writeStore(store)
  return [{ name: keep.name, token: keep.token }]
}

export function namesOwnedByAccount(
  accountId: string,
): { name: string; token: string }[] {
  return reconcileAccountNames(accountId)
}
