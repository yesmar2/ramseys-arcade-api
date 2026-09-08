import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanPlayerName, namesOwnedByAccount, withAvatarIds } from './names.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'groups.json')

const MAX_GROUPS_PER_ACCOUNT = 5
const MAX_MEMBERS = 20
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type GroupMember = {
  name: string
  joinedAt: number
}

export type Group = {
  id: string
  name: string
  inviteCode: string
  createdBy: { accountId: string }
  members: GroupMember[]
}

type Store = { groups: Group[] }

export type GroupAccessOpts = {
  accountId?: string
  playerName?: string
  inviteCode?: string
}

function uid() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function generateInviteCode() {
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]!
  }
  return code
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
    const empty = { groups: [] }
    writeStore(empty)
    return empty
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Store
    if (!Array.isArray(parsed.groups)) return { groups: [] }
    return { groups: parsed.groups.map(normalizeGroup) }
  } catch {
    return { groups: [] }
  }
}

function normalizeGroup(g: Group): Group {
  return {
    id: String(g.id ?? ''),
    name: String(g.name ?? '').trim().slice(0, 32),
    inviteCode: String(g.inviteCode ?? '').toUpperCase(),
    createdBy: { accountId: String(g.createdBy?.accountId ?? '') },
    members: Array.isArray(g.members)
      ? g.members.map((m) => ({
          name: cleanPlayerName(m.name),
          joinedAt: Number(m.joinedAt) || 0,
        }))
      : [],
  }
}

function putGroup(store: Store, group: Group) {
  const idx = store.groups.findIndex((g) => g.id === group.id)
  if (idx >= 0) store.groups[idx] = group
  else store.groups.push(group)
}

function accountNames(accountId?: string): string[] {
  if (!accountId) return []
  return namesOwnedByAccount(accountId).map((n) => n.name)
}

export function isGroupMember(group: Group, opts: GroupAccessOpts = {}): boolean {
  const names = new Set<string>()
  const player = cleanPlayerName(opts.playerName ?? '')
  if (player) names.add(player)
  for (const owned of accountNames(opts.accountId)) names.add(owned)
  return group.members.some((m) => names.has(m.name))
}

export function isGroupOwner(group: Group, accountId?: string): boolean {
  return Boolean(accountId && group.createdBy.accountId === accountId)
}

function canViewGroup(group: Group, opts: GroupAccessOpts = {}): boolean {
  if (isGroupMember(group, opts) || isGroupOwner(group, opts.accountId)) return true
  const invite = opts.inviteCode?.trim().toUpperCase()
  return Boolean(invite && invite === group.inviteCode)
}

export function getGroup(id: string): Group | null {
  const cleaned = id.trim()
  if (!cleaned) return null
  return readStore().groups.find((g) => g.id === cleaned) ?? null
}

export function rosterNameSet(group: Group): Set<string> {
  return new Set(group.members.map((m) => m.name).filter(Boolean))
}

/** `group=everyone` or omitted → null. Unknown/non-member → throw. */
export function resolveBoardScope(
  groupId: string | undefined,
  opts: GroupAccessOpts = {},
): { groupId: string; names: Set<string> } | null {
  const id = groupId?.trim()
  if (!id || id === 'everyone') return null
  const group = assertGroupBoardAccess(id, opts)
  return { groupId: group.id, names: rosterNameSet(group) }
}

/** Member-only. Throws 403/404. */
export function assertGroupBoardAccess(id: string, opts: GroupAccessOpts = {}): Group {
  const group = getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupMember(group, opts) && !isGroupOwner(group, opts.accountId)) {
    fail('Members only', 403, 'GROUP_FORBIDDEN')
  }
  return group
}

export function publicGroup(
  group: Group,
  opts: GroupAccessOpts = {},
): {
  id: string
  name: string
  memberCount: number
  members: Array<GroupMember & { avatarId?: string }>
  isOwner: boolean
  isMember: boolean
  inviteCode: string | null
} {
  const owner = isGroupOwner(group, opts.accountId)
  const member = isGroupMember(group, opts)
  return {
    id: group.id,
    name: group.name,
    memberCount: group.members.length,
    members: withAvatarIds(group.members),
    isOwner: owner,
    isMember: member,
    inviteCode: owner ? group.inviteCode : null,
  }
}

export function listGroupsFor(opts: GroupAccessOpts = {}) {
  const store = readStore()
  return store.groups
    .filter((g) => isGroupMember(g, opts) || isGroupOwner(g, opts.accountId))
    .map((g) => publicGroup(g, opts))
}

export function getGroupDetail(id: string, opts: GroupAccessOpts = {}) {
  const group = getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!canViewGroup(group, opts)) fail('Valid invite required', 403, 'INVITE_REQUIRED')
  return publicGroup(group, opts)
}

export function createGroup(
  rawName: string,
  creator: { accountId: string },
  ownerName?: string,
  now = Date.now(),
) {
  const name = rawName.trim().slice(0, 32)
  if (name.length < 2) fail('Name must be at least 2 characters', 400)
  const store = readStore()
  const hosted = store.groups.filter((g) => g.createdBy.accountId === creator.accountId)
  if (hosted.length >= MAX_GROUPS_PER_ACCOUNT) {
    fail(`You already have ${MAX_GROUPS_PER_ACCOUNT} groups`, 409, 'GROUP_LIMIT')
  }

  const members: GroupMember[] = []
  const tag = cleanPlayerName(ownerName ?? '')
  if (tag) members.push({ name: tag, joinedAt: now })

  const group: Group = {
    id: uid(),
    name,
    inviteCode: generateInviteCode(),
    createdBy: { accountId: creator.accountId },
    members,
  }
  putGroup(store, group)
  writeStore(store)
  return publicGroup(group, { accountId: creator.accountId, playerName: tag })
}

export function joinGroup(
  id: string,
  rawName: string,
  invite: string,
  now = Date.now(),
) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  const code = invite.trim().toUpperCase()
  if (!code || code !== group.inviteCode) fail('Valid invite required', 403, 'INVITE_REQUIRED')

  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (group.members.some((m) => m.name === name)) {
    return publicGroup(group, { playerName: name })
  }
  if (group.members.length >= MAX_MEMBERS) fail('This group is full', 409, 'GROUP_FULL')

  group.members.push({ name, joinedAt: now })
  putGroup(store, group)
  writeStore(store)
  return publicGroup(group, { playerName: name })
}

export function leaveGroup(id: string, rawName: string, accountId?: string) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (!isGroupMember(group, { playerName: name, accountId })) {
    fail('Not a member', 403, 'GROUP_FORBIDDEN')
  }
  if (isGroupOwner(group, accountId) && group.members.length > 1) {
    fail('Transfer or remove others before leaving as owner, or delete the group', 409, 'OWNER_LEAVE')
  }
  group.members = group.members.filter((m) => m.name !== name)
  if (group.members.length === 0 && isGroupOwner(group, accountId)) {
    store.groups = store.groups.filter((g) => g.id !== id)
  } else {
    putGroup(store, group)
  }
  writeStore(store)
  return { ok: true }
}

export function kickMember(id: string, accountId: string, rawName: string) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can remove members', 403)
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400)
  group.members = group.members.filter((m) => m.name !== name)
  putGroup(store, group)
  writeStore(store)
  return publicGroup(group, { accountId })
}

export function renameGroup(id: string, accountId: string, rawName: string) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can rename', 403)
  const name = rawName.trim().slice(0, 32)
  if (name.length < 2) fail('Name must be at least 2 characters', 400)
  group.name = name
  putGroup(store, group)
  writeStore(store)
  return publicGroup(group, { accountId })
}

export function rotateInvite(id: string, accountId: string) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can rotate the invite', 403)
  group.inviteCode = generateInviteCode()
  putGroup(store, group)
  writeStore(store)
  return publicGroup(group, { accountId })
}

export function deleteGroup(id: string, accountId: string) {
  const store = readStore()
  const group = store.groups.find((g) => g.id === id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can delete', 403)
  store.groups = store.groups.filter((g) => g.id !== id)
  writeStore(store)
  return { ok: true }
}

export function renamePlayerAcrossGroups(fromRaw: string, toRaw: string) {
  const from = cleanPlayerName(fromRaw)
  const to = cleanPlayerName(toRaw)
  if (!from || !to || from === to) return { updated: 0 }
  const store = readStore()
  let updated = 0
  for (const group of store.groups) {
    for (const member of group.members) {
      if (member.name === from) {
        member.name = to
        updated += 1
      }
    }
  }
  if (updated) writeStore(store)
  return { updated }
}
