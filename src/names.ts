import crypto from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { nameClaims } from './db/schema.js'
import { announce, onChange, onRewrite } from './feed.js'
import { renamePlayerAcrossGroups } from './groups.js'
import { renamePlayerAcrossLeaderboards } from './store.js'
import { renamePlayerAcrossRecords } from './records.js'
import { renamePlayerAcrossTournaments } from './tournaments.js'
import { renamePlayerAcrossTrophies } from './trophies.js'
import {
  defaultAvatarId,
  isAvatarId,
  type AvatarId,
} from './avatars.js'

export type NameClaim = {
  token: string
  claimedAt: number
  accountId?: string
  avatarId?: AvatarId
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url')
}

export function cleanPlayerName(name: string) {
  return name.trim().slice(0, 12).toUpperCase()
}

function claimFromRow(row: {
  name: string
  token: string
  claimedAt: number
  accountId: string | null
  avatarId: string | null
}): NameClaim {
  return {
    token: row.token,
    claimedAt: row.claimedAt,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.avatarId && isAvatarId(row.avatarId) ? { avatarId: row.avatarId } : {}),
  }
}

export async function getClaim(name: string): Promise<NameClaim | null> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return null
  const rows = await db().select().from(nameClaims).where(eq(nameClaims.name, cleaned)).limit(1)
  return rows[0] ? claimFromRow(rows[0]) : null
}

/*
 * Every board, roster and profile response looks up avatars by tag, and a
 * request could spend a dozen round trips on that alone. So the claims table
 * is read once and kept, by tag and by account, and a claim this process
 * writes is read back into it on its own (refreshClaims). It used to be
 * dropped whole at every claim written, so each new player sent the next
 * request to read every tag on the site again. It is still read again every
 * ten minutes, for scripts. Writes read the database directly through
 * getClaim, so ownership checks are never stale. With more than one server,
 * the tags a claim touched are read back on every server (feed.ts).
 */
type ClaimRow = typeof nameClaims.$inferSelect
const CLAIMS_TTL_MS = 10 * 60_000
type Claims = { at: number; byName: Map<string, ClaimRow>; byAccount: Map<string, ClaimRow[]> }
let claimsCache: Claims | null = null
let claimsLoading: Promise<Claims> | null = null
/** Tags written while the table was being read: read again once it lands. */
let changedDuringLoad = new Set<string>()

export function invalidateClaimCache() {
  claimsCache = null
}

function addToAccount(copy: Claims, row: ClaimRow) {
  if (!row.accountId) return
  const list = copy.byAccount.get(row.accountId)
  if (list) list.push(row)
  else copy.byAccount.set(row.accountId, [row])
}

function dropFromAccount(copy: Claims, row: ClaimRow) {
  if (!row.accountId) return
  const list = copy.byAccount.get(row.accountId)?.filter((r) => r.name !== row.name)
  if (list?.length) copy.byAccount.set(row.accountId, list)
  else copy.byAccount.delete(row.accountId)
}

async function loadClaimsCopy(): Promise<Claims> {
  if (claimsCache && Date.now() - claimsCache.at < CLAIMS_TTL_MS) return claimsCache
  if (claimsLoading) return claimsLoading
  changedDuringLoad = new Set()
  claimsLoading = (async () => {
    const rows = await db().select().from(nameClaims)
    const copy: Claims = { at: Date.now(), byName: new Map(), byAccount: new Map() }
    for (const row of rows) {
      copy.byName.set(row.name, row)
      addToAccount(copy, row)
    }
    claimsCache = copy
    // A claim written while the table was being read may or may not be in what came back.
    if (changedDuringLoad.size) await reloadClaims([...changedDuringLoad])
    return copy
  })().finally(() => {
    claimsLoading = null
  })
  return claimsLoading
}

async function loadClaims(): Promise<Map<string, ClaimRow>> {
  return (await loadClaimsCopy()).byName
}

/** Claims just written: their rows read back into the cache here and on every other server. */
export async function refreshClaims(names: string[]) {
  if (!names.length) return
  await reloadClaims(names)
  await announce('claims', { names })
}

onChange<{ names?: string[] }>('claims', ({ names }) => reloadClaims((names ?? []).map(String)))
onRewrite('claims', () => invalidateClaimCache())

/** Claims changed: their rows read back into the cache, or dropped from it if they're gone. */
async function reloadClaims(names: string[]) {
  if (!names.length) return
  if (claimsLoading) for (const name of names) changedDuringLoad.add(name)
  const copy = claimsCache
  if (!copy) return
  const rows = await db().select().from(nameClaims).where(inArray(nameClaims.name, names))
  if (claimsCache !== copy) return
  const found = new Map(rows.map((r) => [r.name, r] as const))
  for (const name of names) {
    const was = copy.byName.get(name)
    if (was) dropFromAccount(copy, was)
    const row = found.get(name)
    if (row) {
      copy.byName.set(name, row)
      addToAccount(copy, row)
    } else {
      copy.byName.delete(name)
    }
  }
}

/** Local/dev only. Production Render sets NODE_ENV=production. */
export function isDevToolsEnabled() {
  if (process.env.ALLOW_DEV_TOOLS === '0') return false
  if (process.env.ALLOW_DEV_TOOLS === '1') return true
  return process.env.NODE_ENV !== 'production'
}

/**
 * Hand out an existing tag's claim token so a local client can act as that
 * tag for testing. Only ever borrows a tag that's already claimed by a real
 * account — never mints a new, ownerless tag (every gamer tag must belong to
 * a signed-in account).
 */
export async function assumeNameForDev(name: string): Promise<{ name: string; token: string }> {
  if (!isDevToolsEnabled()) {
    throw Object.assign(new Error('Impersonation is disabled'), {
      status: 403,
      code: 'DEV_TOOLS_DISABLED',
    })
  }
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }
  const existing = await getClaim(cleaned)
  if (!existing || !existing.accountId) {
    throw Object.assign(
      new Error('That tag isn’t signed in anywhere yet — impersonation can only borrow an existing tag'),
      { status: 404, code: 'NAME_UNCLAIMED' },
    )
  }
  return { name: cleaned, token: existing.token }
}

export async function isNameAvailable(
  name: string,
  token?: string | null,
  accountId?: string | null,
): Promise<boolean> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return false
  const claim = await getClaim(cleaned)
  if (!claim) return true
  if (token && token === claim.token) return true
  if (accountId && claim.accountId === accountId) return true
  return false
}

export type UseNameAuth = {
  claimToken?: string | null
  accountId?: string | null
}

/** Move leaderboard + tournament rows from one tag to another. */
export async function migratePlayerScores(fromRaw: string, toRaw: string) {
  const from = cleanPlayerName(fromRaw)
  const to = cleanPlayerName(toRaw)
  if (!from || !to || from === to) return { from, to, updated: 0 }
  const boards = await renamePlayerAcrossLeaderboards(from, to)
  await renamePlayerAcrossTournaments(from, to)
  await renamePlayerAcrossRecords(from, to)
  await renamePlayerAcrossTrophies(from, to)
  await renamePlayerAcrossGroups(from, to)
  return boards
}

async function releaseOtherAccountNames(
  accountId: string,
  keepName: string,
): Promise<string[]> {
  const owned = await db()
    .select()
    .from(nameClaims)
    .where(eq(nameClaims.accountId, accountId))
  const released: string[] = []
  for (const row of owned) {
    if (row.name === keepName) continue
    released.push(row.name)
    await db().delete(nameClaims).where(eq(nameClaims.name, row.name))
    await refreshClaims([row.name])
  }
  return released
}

async function releaseAndMigrateAccountNames(
  accountId: string,
  keepName: string,
): Promise<string[]> {
  const released = await releaseOtherAccountNames(accountId, keepName)
  for (const previous of released) {
    await migratePlayerScores(previous, keepName)
  }
  return released
}

/**
 * Claim a player name (or verify an existing claim).
 * Accepts guest claim token and/or owning account id.
 */
export async function claimName(
  name: string,
  token?: string | null,
  accountId?: string | null,
): Promise<{ name: string; token: string; created: boolean }> {
  return assertCanUseName(name, { claimToken: token, accountId })
}

/**
 * Authorize use of a name via guest token or owning session account.
 * Creates the claim if the name is free.
 */
export async function assertCanUseName(
  name: string,
  auth: UseNameAuth = {},
): Promise<{ name: string; token: string; created: boolean }> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }

  const existing = await getClaim(cleaned)
  const { claimToken, accountId } = auth

  if (!existing) {
    if (!accountId) {
      throw Object.assign(new Error('Sign in to claim a gamer tag'), {
        status: 401,
        code: 'AUTH_REQUIRED',
      })
    }
    const next: NameClaim = { token: mintToken(), claimedAt: Date.now() }
    next.accountId = accountId
    await releaseAndMigrateAccountNames(accountId, cleaned)
    await db().insert(nameClaims).values({
      name: cleaned,
      token: next.token,
      claimedAt: next.claimedAt,
      accountId: next.accountId ?? null,
      avatarId: null,
    })
    await refreshClaims([cleaned])
    return { name: cleaned, token: next.token, created: true }
  }

  const tokenOk = Boolean(claimToken && claimToken === existing.token)
  const accountOk = Boolean(accountId && existing.accountId === accountId)

  if (tokenOk || accountOk) {
    if (accountId && tokenOk && !existing.accountId) {
      await releaseAndMigrateAccountNames(accountId, cleaned)
      await db()
        .update(nameClaims)
        .set({ accountId })
        .where(eq(nameClaims.name, cleaned))
      await refreshClaims([cleaned])
    }
    return { name: cleaned, token: existing.token, created: false }
  }

  throw Object.assign(new Error('That name is already taken'), {
    status: 409,
    code: 'NAME_TAKEN',
  })
}

/** Verify ownership without creating a new claim. */
export async function assertOwnsName(
  name: string,
  token?: string | null,
  accountId?: string | null,
): Promise<string> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }
  const existing = await getClaim(cleaned)
  if (!existing) {
    throw Object.assign(new Error('Name is not claimed'), {
      status: 409,
      code: 'NAME_UNCLAIMED',
    })
  }
  // Account-linked tags can only be controlled by that account — a leftover
  // device claim token must not let another signed-in account rename them
  // (that was rewriting group rosters when switching Google accounts).
  if (existing.accountId) {
    if (accountId && existing.accountId === accountId) return cleaned
    throw Object.assign(new Error('That name is already taken'), {
      status: 409,
      code: 'NAME_TAKEN',
    })
  }
  if (token && token === existing.token) return cleaned
  throw Object.assign(new Error('That name is already taken'), {
    status: 409,
    code: 'NAME_TAKEN',
  })
}

/**
 * Rename a gamer tag: prove ownership of `from`, claim `to`, move scores,
 * and free the old claim.
 */
export async function renameGamerTag(
  fromRaw: string,
  toRaw: string,
  auth: UseNameAuth & { fromToken?: string | null } = {},
): Promise<{
  name: string
  token: string
  created: boolean
  from: string
  migratedFrom: string[]
}> {
  const from = cleanPlayerName(fromRaw)
  const to = cleanPlayerName(toRaw)
  if (!from || !to) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }

  if (from === to) {
    const same = await assertCanUseName(to, {
      claimToken: auth.claimToken,
      accountId: auth.accountId,
    })
    return { ...same, from, migratedFrom: [] }
  }

  await assertOwnsName(from, auth.fromToken, auth.accountId)

  const fromClaim = await getClaim(from)
  const fromAvatar = fromClaim?.avatarId

  const toClaim = await assertCanUseName(to, {
    claimToken: auth.claimToken,
    accountId: auth.accountId,
  })

  await migratePlayerScores(from, to)

  if (fromAvatar) {
    const toRow = await getClaim(to)
    if (toRow && !toRow.avatarId) {
      await db()
        .update(nameClaims)
        .set({ avatarId: fromAvatar })
        .where(eq(nameClaims.name, to))
    }
  }
  await db().delete(nameClaims).where(eq(nameClaims.name, from))
  await refreshClaims([from, to])

  const migratedFrom = [from]
  if (auth.accountId) {
    const extras = await releaseAndMigrateAccountNames(auth.accountId, to)
    migratedFrom.push(...extras)
  }

  return {
    name: toClaim.name,
    token: toClaim.token,
    created: toClaim.created,
    from,
    migratedFrom: [...new Set(migratedFrom)],
  }
}

/**
 * Bind a name to an account as its only active gamer tag.
 * Previously linked tags are deleted (freed) and returned so callers can
 * rename historical scores.
 */
export async function linkNameToAccount(
  name: string,
  claimToken: string | null | undefined,
  accountId: string,
  previousName?: string | null,
  previousToken?: string | null,
): Promise<{ name: string; token: string; created: boolean; previousNames: string[] }> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) {
    throw Object.assign(new Error('Name required'), { status: 400, code: 'NAME_REQUIRED' })
  }
  if (!accountId) {
    throw Object.assign(new Error('Account required'), { status: 401, code: 'AUTH_REQUIRED' })
  }

  const prev = previousName ? cleanPlayerName(previousName) : ''
  // Only migrate when the previous tag already belongs to this account, or is
  // still a guest claim on this device. Never migrate another account's tag
  // just because a claim token was left in localStorage.
  if (prev && prev !== cleaned) {
    const prevClaim = await getClaim(prev)
    const ownedByThisAccount = Boolean(prevClaim && prevClaim.accountId === accountId)
    const guestOnDevice = Boolean(
      prevClaim &&
        !prevClaim.accountId &&
        ((previousToken && previousToken === prevClaim.token) ||
          (claimToken && claimToken === prevClaim.token)),
    )
    if (ownedByThisAccount || guestOnDevice) {
      try {
        const renamed = await renameGamerTag(prev, cleaned, {
          fromToken: previousToken ?? claimToken,
          claimToken,
          accountId,
        })
        return {
          ...renamed,
          previousNames: [prev],
        }
      } catch {
        /* fall through to normal link */
      }
    }
  }

  const existing = await getClaim(cleaned)
  let created = false
  let token: string

  if (!existing) {
    token = mintToken()
    await db().insert(nameClaims).values({
      name: cleaned,
      token,
      claimedAt: Date.now(),
      accountId,
      avatarId: null,
    })
    created = true
  } else if (existing.accountId && existing.accountId !== accountId) {
    throw Object.assign(new Error('That name is linked to another account'), {
      status: 409,
      code: 'NAME_TAKEN',
    })
  } else if (existing.accountId === accountId) {
    token = existing.token
  } else if (claimToken && claimToken === existing.token) {
    await db()
      .update(nameClaims)
      .set({ accountId })
      .where(eq(nameClaims.name, cleaned))
    token = existing.token
  } else if (!existing.accountId) {
    // Orphan / previously released claim with no owner — adopt it.
    token = mintToken()
    await db()
      .update(nameClaims)
      .set({
        accountId,
        token,
        claimedAt: Date.now(),
      })
      .where(eq(nameClaims.name, cleaned))
  } else {
    throw Object.assign(
      new Error('Sign in from the device that claimed this name, then link it'),
      { status: 403, code: 'NAME_PROOF_REQUIRED' },
    )
  }

  await refreshClaims([cleaned])
  const previousNames = await releaseAndMigrateAccountNames(accountId, cleaned)

  return { name: cleaned, token, created, previousNames }
}

/** Heal accounts that somehow own multiple tags; keep the newest. */
export async function reconcileAccountNames(
  accountId: string,
): Promise<{ name: string; token: string }[]> {
  if (!accountId) return []
  const owned = await db()
    .select()
    .from(nameClaims)
    .where(eq(nameClaims.accountId, accountId))
  if (owned.length <= 1) {
    return owned.map((row) => ({ name: row.name, token: row.token }))
  }

  owned.sort((a, b) => b.claimedAt - a.claimedAt)
  const keep = owned[0]!
  await releaseAndMigrateAccountNames(accountId, keep.name)
  const kept = await getClaim(keep.name)
  return kept ? [{ name: keep.name, token: kept.token }] : []
}

export async function namesOwnedByAccount(
  accountId: string,
): Promise<{ name: string; token: string; avatarId: AvatarId }[]> {
  if (!accountId) return []
  // The common case — one tag per account — is answered from the cache. An
  // account holding several tags is reconciled through the database.
  const cached = (await loadClaimsCopy()).byAccount.get(accountId) ?? []
  const rows = cached.length <= 1 ? cached : await reconcileAccountNames(accountId)
  const result: { name: string; token: string; avatarId: AvatarId }[] = []
  for (const row of rows) {
    result.push({
      name: row.name,
      token: row.token,
      avatarId: await resolveAvatarId(row.name),
    })
  }
  return result
}

/** Resolved avatar for a tag (saved or hash default). */
export async function resolveAvatarId(name: string): Promise<AvatarId> {
  const cleaned = cleanPlayerName(name)
  if (!cleaned) return defaultAvatarId('')
  const claim = (await loadClaims()).get(cleaned)
  if (claim?.avatarId && isAvatarId(claim.avatarId)) return claim.avatarId
  return defaultAvatarId(cleaned)
}

export async function withAvatarId<T extends { name: string }>(
  row: T,
): Promise<T & { avatarId: AvatarId }> {
  return { ...row, avatarId: await resolveAvatarId(row.name) }
}

export async function withAvatarIds<T extends { name: string }>(
  rows: T[],
): Promise<Array<T & { avatarId: AvatarId }>> {
  if (!rows.length) return []
  const byName = await loadClaims()
  return rows.map((row) => {
    const cleaned = cleanPlayerName(row.name)
    const claim = byName.get(cleaned)
    const avatarId =
      claim?.avatarId && isAvatarId(claim.avatarId)
        ? claim.avatarId
        : defaultAvatarId(cleaned)
    return { ...row, avatarId }
  })
}

export async function setNameAvatar(
  name: string,
  avatarId: string,
  auth: UseNameAuth = {},
): Promise<{ name: string; avatarId: AvatarId; token: string }> {
  if (!isAvatarId(avatarId)) {
    throw Object.assign(new Error('Unknown avatar'), { status: 400, code: 'BAD_AVATAR' })
  }
  const cleaned = await assertOwnsName(name, auth.claimToken, auth.accountId)
  const claim = await getClaim(cleaned)
  if (!claim) {
    throw Object.assign(new Error('Name is not claimed'), {
      status: 409,
      code: 'NAME_UNCLAIMED',
    })
  }
  await db()
    .update(nameClaims)
    .set({ avatarId })
    .where(eq(nameClaims.name, cleaned))
  await refreshClaims([cleaned])
  return { name: cleaned, avatarId, token: claim.token }
}
