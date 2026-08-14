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

export function isNameAvailable(name: string, token?: string | null): boolean {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return false
  const claim = getClaim(cleaned)
  if (!claim) return true
  return Boolean(token && token === claim.token)
}

/**
 * Claim a player name (or verify an existing claim).
 * Returns the claim token the client must store and send with later requests.
 */
export function claimName(
  name: string,
  token?: string | null,
): { name: string; token: string; created: boolean } {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }

  const store = ensureStore()
  const existing = store.claims[cleaned]

  if (!existing) {
    const next: NameClaim = { token: mintToken(), claimedAt: Date.now() }
    store.claims[cleaned] = next
    writeStore(store)
    return { name: cleaned, token: next.token, created: true }
  }

  if (token && token === existing.token) {
    return { name: cleaned, token: existing.token, created: false }
  }

  throw Object.assign(new Error('That name is already taken'), {
    status: 409,
    code: 'NAME_TAKEN',
  })
}

/** Verify ownership without creating a new claim. */
export function assertOwnsName(name: string, token?: string | null): string {
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
  if (!token || token !== existing.token) {
    throw Object.assign(new Error('That name is already taken'), {
      status: 409,
      code: 'NAME_TAKEN',
    })
  }
  return cleaned
}
