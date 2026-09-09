import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'invites.json')

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

type Store = { invites: DirectedInvite[] }

function uid() {
  return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fail(message: string, status: number, code?: string): never {
  throw Object.assign(new Error(message), { status, code })
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function writeStore(store: Store) {
  ensureDataDir()
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, STORE_PATH)
}

function readStore(): Store {
  ensureDataDir()
  if (!fs.existsSync(STORE_PATH)) {
    const empty = { invites: [] }
    writeStore(empty)
    return empty
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Store
    if (!Array.isArray(parsed.invites)) return { invites: [] }
    return { invites: parsed.invites.map(normalizeInvite) }
  } catch {
    return { invites: [] }
  }
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

function putInvite(store: Store, invite: DirectedInvite) {
  const idx = store.invites.findIndex((i) => i.id === invite.id)
  if (idx >= 0) store.invites[idx] = invite
  else store.invites.push(invite)
}

function isExpired(invite: DirectedInvite, now = Date.now()) {
  return invite.expiresAt > 0 && invite.expiresAt <= now
}

function expirePending(store: Store, now = Date.now()) {
  let dirty = false
  for (const invite of store.invites) {
    if (invite.status === 'pending' && isExpired(invite, now)) {
      invite.status = 'revoked'
      dirty = true
    }
  }
  return dirty
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

function recipientNames(opts: { playerName?: string; accountId?: string }): Set<string> {
  const names = new Set<string>()
  const player = cleanPlayerName(opts.playerName ?? '')
  if (player) names.add(player)
  if (opts.accountId) {
    for (const owned of namesOwnedByAccount(opts.accountId)) names.add(owned.name)
  }
  return names
}

function alreadyOnTarget(kind: InviteKind, targetId: string, toName: string): boolean {
  if (kind === 'group') {
    const group = getGroup(targetId)
    if (!group) return false
    return isGroupMember(group, { playerName: toName })
  }
  const t = getTournament(targetId)
  if (!t) return false
  const cleaned = cleanPlayerName(toName)
  return t.players.some((p) => p.name === cleaned)
}

export function createDirectedInvite(input: {
  kind: InviteKind
  targetId: string
  toName: string
  fromAccountId: string
  fromName?: string
  now?: number
}): PublicInvite {
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
    const group = getGroup(input.targetId)
    if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
    if (!isGroupOwner(group, input.fromAccountId)) {
      fail('Only the group owner can invite', 403, 'GROUP_FORBIDDEN')
    }
    if (isGroupMember(group, { playerName: toName })) {
      fail(`${toName} is already in this group`, 409, 'ALREADY_MEMBER')
    }
    targetName = group.name
    inviteCode = group.inviteCode
  } else {
    const t = getTournament(input.targetId)
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

  const store = readStore()
  expirePending(store, now)

  for (const existing of store.invites) {
    if (
      existing.status === 'pending' &&
      existing.kind === input.kind &&
      existing.targetId === input.targetId &&
      existing.toName === toName
    ) {
      existing.status = 'revoked'
    }
  }

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
  putInvite(store, invite)
  writeStore(store)
  return publicInvite(invite)
}

export function listPendingInvites(opts: {
  playerName?: string
  accountId?: string
  now?: number
}): PublicInvite[] {
  const names = recipientNames(opts)
  if (names.size === 0) return []

  const now = opts.now ?? Date.now()
  const store = readStore()
  const dirty = expirePending(store, now)
  if (dirty) writeStore(store)

  return store.invites
    .filter(
      (i) =>
        i.status === 'pending' &&
        !isExpired(i, now) &&
        names.has(i.toName) &&
        !alreadyOnTarget(i.kind, i.targetId, i.toName),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicInvite)
}

function assertRecipient(
  invite: DirectedInvite,
  rawName: string,
  opts: { accountId?: string },
) {
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (name !== invite.toName) {
    fail('This invite is for a different gamer tag', 403, 'INVITE_WRONG_TAG')
  }
  const allowed = recipientNames({ playerName: name, accountId: opts.accountId })
  if (!allowed.has(name)) fail('Not allowed', 403, 'FORBIDDEN')
  return name
}

export function acceptInvite(
  id: string,
  rawName: string,
  opts: { accountId?: string; claimToken?: string; now?: number } = {},
) {
  const now = opts.now ?? Date.now()
  const store = readStore()
  expirePending(store, now)
  const invite = store.invites.find((i) => i.id === id)
  if (!invite) fail('Invite not found', 404, 'INVITE_NOT_FOUND')
  if (invite.status !== 'pending' || isExpired(invite, now)) {
    fail('This invite is no longer available', 409, 'INVITE_INACTIVE')
  }

  const name = assertRecipient(invite, rawName, opts)

  if (invite.kind === 'group') {
    const group = joinGroup(invite.targetId, name, invite.inviteCode, now)
    invite.status = 'accepted'
    putInvite(store, invite)
    writeStore(store)
    return {
      invite: publicInvite(invite),
      kind: 'group' as const,
      group,
    }
  }

  const joined = joinTournament(invite.targetId, name, now, null, {
    inviteCode: invite.inviteCode,
    accountId: opts.accountId,
    playerName: name,
  })
  invite.status = 'accepted'
  putInvite(store, invite)
  writeStore(store)
  return {
    invite: publicInvite(invite),
    kind: 'tournament' as const,
    tournament: joined.tournament,
    player: joined.player,
  }
}

export function declineInvite(
  id: string,
  rawName: string,
  opts: { accountId?: string; now?: number } = {},
) {
  const now = opts.now ?? Date.now()
  const store = readStore()
  expirePending(store, now)
  const invite = store.invites.find((i) => i.id === id)
  if (!invite) fail('Invite not found', 404, 'INVITE_NOT_FOUND')
  if (invite.status !== 'pending' || isExpired(invite, now)) {
    fail('This invite is no longer available', 409, 'INVITE_INACTIVE')
  }
  assertRecipient(invite, rawName, opts)
  invite.status = 'declined'
  putInvite(store, invite)
  writeStore(store)
  return { invite: publicInvite(invite) }
}
