import { and, eq, lt } from 'drizzle-orm'
import { db } from './db/client.js'
import { directedInvites } from './db/schema.js'
import { cleanPlayerName, namesOwnedByAccount } from './names.js'
import {
  getGroup,
  isGroupMember,
  isGroupOwner,
  joinGroup,
} from './groups.js'
import {
  getTournament,
  joinTournament,
} from './tournaments.js'

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export type InviteKind = 'group' | 'tournament'
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked'

export type DirectedInvite = {
  id: string
  kind: InviteKind
  targetId: string
  targetName: string
  fromAccountId: string
  fromName: string | null
  toName: string
  inviteCode: string
  status: InviteStatus
  createdAt: number
  expiresAt: number
}

export type PublicInvite = {
  id: string
  kind: InviteKind
  targetId: string
  targetName: string
  fromName: string | null
  toName: string
  status: InviteStatus
  createdAt: number
  expiresAt: number
}

function uid() {
  return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fail(message: string, status: number, code?: string): never {
  throw Object.assign(new Error(message), { status, code })
}

function normalizeInvite(raw: DirectedInvite): DirectedInvite {
  return {
    id: String(raw.id ?? ''),
    kind: raw.kind === 'tournament' ? 'tournament' : 'group',
    targetId: String(raw.targetId ?? ''),
    targetName: String(raw.targetName ?? '').trim().slice(0, 60),
    fromAccountId: String(raw.fromAccountId ?? ''),
    fromName: raw.fromName ? cleanPlayerName(raw.fromName) : null,
    toName: cleanPlayerName(raw.toName ?? ''),
    inviteCode: String(raw.inviteCode ?? '').toUpperCase(),
    status: (['pending', 'accepted', 'declined', 'revoked'] as const).includes(
      raw.status as InviteStatus,
    )
      ? (raw.status as InviteStatus)
      : 'pending',
    createdAt: Number(raw.createdAt) || 0,
    expiresAt: Number(raw.expiresAt) || 0,
  }
}

function rowToInvite(row: typeof directedInvites.$inferSelect): DirectedInvite {
  return normalizeInvite({
    id: row.id,
    kind: row.kind as InviteKind,
    targetId: row.targetId,
    targetName: row.targetName,
    fromAccountId: row.fromAccountId,
    fromName: row.fromName,
    toName: row.toName,
    inviteCode: row.inviteCode,
    status: row.status as InviteStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  })
}

async function upsertInvite(invite: DirectedInvite) {
  await db()
    .insert(directedInvites)
    .values({
      id: invite.id,
      kind: invite.kind,
      targetId: invite.targetId,
      targetName: invite.targetName,
      fromAccountId: invite.fromAccountId,
      fromName: invite.fromName,
      toName: invite.toName,
      inviteCode: invite.inviteCode,
      status: invite.status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    })
    .onConflictDoUpdate({
      target: directedInvites.id,
      set: {
        kind: invite.kind,
        targetId: invite.targetId,
        targetName: invite.targetName,
        fromAccountId: invite.fromAccountId,
        fromName: invite.fromName,
        toName: invite.toName,
        inviteCode: invite.inviteCode,
        status: invite.status,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      },
    })
}

function isExpired(invite: DirectedInvite, now = Date.now()) {
  return invite.expiresAt > 0 && invite.expiresAt <= now
}

async function expirePending(now = Date.now()) {
  await db()
    .update(directedInvites)
    .set({ status: 'revoked' })
    .where(and(eq(directedInvites.status, 'pending'), lt(directedInvites.expiresAt, now)))
}

export function publicInvite(invite: DirectedInvite): PublicInvite {
  return {
    id: invite.id,
    kind: invite.kind,
    targetId: invite.targetId,
    targetName: invite.targetName,
    fromName: invite.fromName,
    toName: invite.toName,
    status: invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  }
}

async function recipientNames(opts: {
  playerName?: string
  accountId?: string
}): Promise<Set<string>> {
  const names = new Set<string>()
  const player = cleanPlayerName(opts.playerName ?? '')
  if (player) names.add(player)
  if (opts.accountId) {
    for (const owned of await namesOwnedByAccount(opts.accountId)) names.add(owned.name)
  }
  return names
}

async function alreadyOnTarget(
  kind: InviteKind,
  targetId: string,
  toName: string,
): Promise<boolean> {
  if (kind === 'group') {
    const group = await getGroup(targetId)
    if (!group) return false
    return await isGroupMember(group, { playerName: toName })
  }
  const t = await getTournament(targetId)
  if (!t) return false
  const cleaned = cleanPlayerName(toName)
  return t.players.some((p) => p.name === cleaned)
}

export async function createDirectedInvite(input: {
  kind: InviteKind
  targetId: string
  toName: string
  fromAccountId: string
  fromName?: string
  now?: number
}): Promise<PublicInvite> {
  const now = input.now ?? Date.now()
  const toName = cleanPlayerName(input.toName)
  if (!toName) fail('Gamer tag required', 400, 'NAME_REQUIRED')

  const fromName = cleanPlayerName(input.fromName ?? '') || null
  if (fromName && fromName === toName) {
    fail('You can’t invite your own tag', 400, 'SELF_INVITE')
  }

  let targetName = ''
  let inviteCode = ''

  if (input.kind === 'group') {
    const group = await getGroup(input.targetId)
    if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
    if (!isGroupOwner(group, input.fromAccountId)) {
      fail('Only the group owner can invite', 403, 'GROUP_FORBIDDEN')
    }
    if (await isGroupMember(group, { playerName: toName })) {
      fail(`${toName} is already in this group`, 409, 'ALREADY_MEMBER')
    }
    targetName = group.name
    inviteCode = group.inviteCode
  } else {
    const t = await getTournament(input.targetId)
    if (!t) fail('Event not found', 404, 'TOURNAMENT_NOT_FOUND')
    if (!t.createdBy || t.createdBy.accountId !== input.fromAccountId) {
      fail('Only the host can invite', 403, 'EVENT_FORBIDDEN')
    }
    if ((t.visibility ?? 'public') !== 'private') {
      fail('Directed invites are for private events', 400, 'NOT_PRIVATE')
    }
    if (!t.inviteCode) fail('This event has no invite code', 400, 'NO_INVITE')
    if (t.players.some((p) => p.name === toName)) {
      fail(`${toName} is already in this event`, 409, 'ALREADY_MEMBER')
    }
    targetName = t.title
    inviteCode = t.inviteCode
  }

  await expirePending(now)

  await db()
    .update(directedInvites)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(directedInvites.status, 'pending'),
        eq(directedInvites.kind, input.kind),
        eq(directedInvites.targetId, input.targetId),
        eq(directedInvites.toName, toName),
      ),
    )

  const invite: DirectedInvite = {
    id: uid(),
    kind: input.kind,
    targetId: input.targetId,
    targetName,
    fromAccountId: input.fromAccountId,
    fromName,
    toName,
    inviteCode: inviteCode.toUpperCase(),
    status: 'pending',
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  }
  await upsertInvite(invite)
  return publicInvite(invite)
}

export async function listPendingInvites(opts: {
  playerName?: string
  accountId?: string
  now?: number
}): Promise<PublicInvite[]> {
  const names = await recipientNames(opts)
  if (names.size === 0) return []

  const now = opts.now ?? Date.now()
  await expirePending(now)

  const rows = await db().select().from(directedInvites)
  const out: PublicInvite[] = []
  for (const row of rows.map(rowToInvite).sort((a, b) => b.createdAt - a.createdAt)) {
    if (row.status !== 'pending' || isExpired(row, now) || !names.has(row.toName)) continue
    if (await alreadyOnTarget(row.kind, row.targetId, row.toName)) continue
    out.push(publicInvite(row))
  }
  return out
}

async function assertRecipient(
  invite: DirectedInvite,
  rawName: string,
  opts: { accountId?: string },
) {
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (name !== invite.toName) {
    fail('This invite is for a different gamer tag', 403, 'INVITE_WRONG_TAG')
  }
  const allowed = await recipientNames({ playerName: name, accountId: opts.accountId })
  if (!allowed.has(name)) fail('Not allowed', 403, 'FORBIDDEN')
  return name
}

export async function acceptInvite(
  id: string,
  rawName: string,
  opts: { accountId?: string; claimToken?: string; now?: number } = {},
) {
  const now = opts.now ?? Date.now()
  await expirePending(now)
  const rows = await db().select().from(directedInvites).where(eq(directedInvites.id, id)).limit(1)
  const invite = rows[0] ? rowToInvite(rows[0]) : null
  if (!invite) fail('Invite not found', 404, 'INVITE_NOT_FOUND')
  if (invite.status !== 'pending' || isExpired(invite, now)) {
    fail('This invite is no longer available', 409, 'INVITE_INACTIVE')
  }

  const name = await assertRecipient(invite, rawName, opts)

  if (invite.kind === 'group') {
    const group = await joinGroup(invite.targetId, name, invite.inviteCode, now)
    invite.status = 'accepted'
    await upsertInvite(invite)
    return {
      invite: publicInvite(invite),
      kind: 'group' as const,
      group,
    }
  }

  const joined = await joinTournament(invite.targetId, name, now, null, {
    inviteCode: invite.inviteCode,
    accountId: opts.accountId,
    playerName: name,
  })
  invite.status = 'accepted'
  await upsertInvite(invite)
  return {
    invite: publicInvite(invite),
    kind: 'tournament' as const,
    tournament: joined.tournament,
    player: joined.player,
  }
}

export async function declineInvite(
  id: string,
  rawName: string,
  opts: { accountId?: string; now?: number } = {},
) {
  const now = opts.now ?? Date.now()
  await expirePending(now)
  const rows = await db().select().from(directedInvites).where(eq(directedInvites.id, id)).limit(1)
  const invite = rows[0] ? rowToInvite(rows[0]) : null
  if (!invite) fail('Invite not found', 404, 'INVITE_NOT_FOUND')
  if (invite.status !== 'pending' || isExpired(invite, now)) {
    fail('This invite is no longer available', 409, 'INVITE_INACTIVE')
  }
  await assertRecipient(invite, rawName, opts)
  invite.status = 'declined'
  await upsertInvite(invite)
  return { invite: publicInvite(invite) }
}
