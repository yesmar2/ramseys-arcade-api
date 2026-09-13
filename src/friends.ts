import { and, eq, lt, or } from 'drizzle-orm'
import { db } from './db/client.js'
import { friendRequests, friendships } from './db/schema.js'
import { cleanPlayerName, getClaim, namesOwnedByAccount, resolveAvatarId } from './names.js'
import type { AvatarId } from './avatars.js'

const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'revoked'

type FriendRequestRow = {
  id: string
  fromAccountId: string
  fromName: string | null
  toAccountId: string
  toName: string
  status: FriendRequestStatus
  createdAt: number
  expiresAt: number
}

export type PublicFriendRequest = {
  id: string
  direction: 'incoming' | 'outgoing'
  name: string
  createdAt: number
}

export type PublicFriend = {
  accountId: string
  name: string
  avatarId: AvatarId
  since: number
}

function uid() {
  return `fr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fail(message: string, status: number, code?: string): never {
  throw Object.assign(new Error(message), { status, code })
}

function rowToRequest(row: typeof friendRequests.$inferSelect): FriendRequestRow {
  return {
    id: row.id,
    fromAccountId: row.fromAccountId,
    fromName: row.fromName,
    toAccountId: row.toAccountId,
    toName: row.toName,
    status: (['pending', 'accepted', 'declined', 'revoked'] as const).includes(
      row.status as FriendRequestStatus,
    )
      ? (row.status as FriendRequestStatus)
      : 'pending',
    createdAt: Number(row.createdAt) || 0,
    expiresAt: Number(row.expiresAt) || 0,
  }
}

function isExpired(row: FriendRequestRow, now: number) {
  return row.expiresAt > 0 && row.expiresAt <= now
}

async function expirePending(now = Date.now()) {
  await db()
    .update(friendRequests)
    .set({ status: 'revoked' })
    .where(and(eq(friendRequests.status, 'pending'), lt(friendRequests.expiresAt, now)))
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

async function displayNameFor(accountId: string): Promise<string> {
  const owned = await namesOwnedByAccount(accountId)
  return owned[0]?.name ?? 'PLAYER'
}

export async function areFriends(accountIdA: string, accountIdB: string): Promise<boolean> {
  const [a, b] = canonicalPair(accountIdA, accountIdB)
  const rows = await db()
    .select()
    .from(friendships)
    .where(and(eq(friendships.accountIdA, a), eq(friendships.accountIdB, b)))
    .limit(1)
  return rows.length > 0
}

async function findPendingRequest(
  fromAccountId: string,
  toAccountId: string,
): Promise<FriendRequestRow | null> {
  const rows = await db()
    .select()
    .from(friendRequests)
    .where(
      and(
        eq(friendRequests.fromAccountId, fromAccountId),
        eq(friendRequests.toAccountId, toAccountId),
        eq(friendRequests.status, 'pending'),
      ),
    )
  const now = Date.now()
  for (const row of rows.map(rowToRequest)) {
    if (!isExpired(row, now)) return row
  }
  return null
}

async function createFriendship(accountIdA: string, accountIdB: string, now: number) {
  const [a, b] = canonicalPair(accountIdA, accountIdB)
  const existing = await db()
    .select()
    .from(friendships)
    .where(and(eq(friendships.accountIdA, a), eq(friendships.accountIdB, b)))
    .limit(1)
  if (existing.length > 0) return
  await db().insert(friendships).values({ id: uid(), accountIdA: a, accountIdB: b, createdAt: now })
}

async function setRequestStatus(id: string, status: FriendRequestStatus) {
  await db().update(friendRequests).set({ status }).where(eq(friendRequests.id, id))
}

/**
 * Send a friend request by gamer tag. If the recipient already sent one to
 * us, accept immediately instead of leaving two crossed pending requests.
 */
export async function sendFriendRequest(
  fromAccountId: string,
  toTagRaw: string,
  now = Date.now(),
): Promise<{ status: 'pending' | 'accepted'; request?: PublicFriendRequest }> {
  const toName = cleanPlayerName(toTagRaw)
  if (!toName) fail('Gamer tag required', 400, 'NAME_REQUIRED')

  const claim = await getClaim(toName)
  if (!claim?.accountId) {
    fail(`Huh — ${toName} doesn’t exist in this arcade`, 404, 'NOT_A_PLAYER')
  }
  const toAccountId = claim.accountId
  if (toAccountId === fromAccountId) {
    fail("You can't friend yourself", 400, 'SELF_FRIEND')
  }

  await expirePending(now)

  if (await areFriends(fromAccountId, toAccountId)) {
    fail(`You and ${toName} are already friends`, 409, 'ALREADY_FRIENDS')
  }

  const reverse = await findPendingRequest(toAccountId, fromAccountId)
  if (reverse) {
    await setRequestStatus(reverse.id, 'accepted')
    await createFriendship(fromAccountId, toAccountId, now)
    return { status: 'accepted' }
  }

  const existing = await findPendingRequest(fromAccountId, toAccountId)
  if (existing) {
    return {
      status: 'pending',
      request: { id: existing.id, direction: 'outgoing', name: existing.toName, createdAt: existing.createdAt },
    }
  }

  const fromName = await displayNameFor(fromAccountId)
  const row: FriendRequestRow = {
    id: uid(),
    fromAccountId,
    fromName,
    toAccountId,
    toName,
    status: 'pending',
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
  }
  await db().insert(friendRequests).values(row)
  return {
    status: 'pending',
    request: { id: row.id, direction: 'outgoing', name: row.toName, createdAt: row.createdAt },
  }
}

export async function listFriendRequests(accountId: string): Promise<PublicFriendRequest[]> {
  await expirePending()
  const rows = await db()
    .select()
    .from(friendRequests)
    .where(
      and(
        eq(friendRequests.status, 'pending'),
        or(eq(friendRequests.fromAccountId, accountId), eq(friendRequests.toAccountId, accountId)),
      ),
    )
  const now = Date.now()
  return rows
    .map(rowToRequest)
    .filter((r) => !isExpired(r, now))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) =>
      r.fromAccountId === accountId
        ? { id: r.id, direction: 'outgoing' as const, name: r.toName, createdAt: r.createdAt }
        : { id: r.id, direction: 'incoming' as const, name: r.fromName ?? 'PLAYER', createdAt: r.createdAt },
    )
}

export async function listFriends(accountId: string): Promise<PublicFriend[]> {
  const rows = await db()
    .select()
    .from(friendships)
    .where(or(eq(friendships.accountIdA, accountId), eq(friendships.accountIdB, accountId)))
  const out: PublicFriend[] = []
  for (const row of rows) {
    const otherId = row.accountIdA === accountId ? row.accountIdB : row.accountIdA
    const name = await displayNameFor(otherId)
    out.push({ accountId: otherId, name, avatarId: await resolveAvatarId(name), since: Number(row.createdAt) })
  }
  return out.sort((a, b) => b.since - a.since)
}

async function loadPendingRequest(id: string, now: number): Promise<FriendRequestRow> {
  const rows = await db().select().from(friendRequests).where(eq(friendRequests.id, id)).limit(1)
  const row = rows[0] ? rowToRequest(rows[0]) : null
  if (!row) fail('Request not found', 404, 'REQUEST_NOT_FOUND')
  if (row.status !== 'pending' || isExpired(row, now)) {
    fail('This request is no longer available', 409, 'REQUEST_INACTIVE')
  }
  return row
}

export async function acceptFriendRequest(id: string, accountId: string, now = Date.now()) {
  const row = await loadPendingRequest(id, now)
  if (row.toAccountId !== accountId) fail('Not allowed', 403, 'FORBIDDEN')
  await setRequestStatus(id, 'accepted')
  await createFriendship(row.fromAccountId, row.toAccountId, now)
  return { accountId: row.fromAccountId, name: row.fromName ?? 'PLAYER' }
}

export async function declineFriendRequest(id: string, accountId: string, now = Date.now()) {
  const row = await loadPendingRequest(id, now)
  if (row.toAccountId !== accountId) fail('Not allowed', 403, 'FORBIDDEN')
  await setRequestStatus(id, 'declined')
}

export async function cancelFriendRequest(id: string, accountId: string, now = Date.now()) {
  const row = await loadPendingRequest(id, now)
  if (row.fromAccountId !== accountId) fail('Not allowed', 403, 'FORBIDDEN')
  await setRequestStatus(id, 'revoked')
}

export async function removeFriend(accountId: string, otherAccountId: string) {
  const [a, b] = canonicalPair(accountId, otherAccountId)
  await db()
    .delete(friendships)
    .where(and(eq(friendships.accountIdA, a), eq(friendships.accountIdB, b)))
}
