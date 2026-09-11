import crypto from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { nameClaims } from './db/schema.js'
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

/** Local/dev only. Production Render sets NODE_ENV=production. */
export function isDevToolsEnabled() {
  if (process.env.ALLOW_DEV_TOOLS === '0') return false
  if (process.env.ALLOW_DEV_TOOLS === '1') return true
  return process.env.NODE_ENV !== 'production'
}

/** Hand out an existing (or new) claim token so a local client can act as that tag. */
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
  if (existing) {
    return { name: cleaned, token: existing.token }
  }
  const next: NameClaim = { token: mintToken(), claimedAt: Date.now() }
  await db().insert(nameClaims).values({
    name: cleaned,
    token: next.token,
    claimedAt: next.claimedAt,
    accountId: null,
    avatarId: null,
  })
  return { name: cleaned, token: next.token }
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
  // Guest tag → account rename: move scores before claims are shuffled.
  if (prev && prev !== cleaned) {
    const prevClaim = await getClaim(prev)
    const canMigrate =
      (prevClaim && prevClaim.accountId === accountId) ||
      (prevClaim && previousToken && previousToken === prevClaim.token) ||
      (prevClaim && claimToken && claimToken === prevClaim.token)
    if (canMigrate) {
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
  const rows = await reconcileAccountNames(accountId)
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
  const claim = await getClaim(cleaned)
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
  const cleanedNames = [
    ...new Set(rows.map((r) => cleanPlayerName(r.name)).filter(Boolean)),
  ]
  const claimRows =
    cleanedNames.length > 0
      ? await db().select().from(nameClaims).where(inArray(nameClaims.name, cleanedNames))
      : []
  const byName = new Map(claimRows.map((r) => [r.name, r] as const))
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
  return { name: cleaned, avatarId, token: claim.token }
}
