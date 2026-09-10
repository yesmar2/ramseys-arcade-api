import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { groupMembers, groups } from './db/schema.js'
import { cleanPlayerName, namesOwnedByAccount, withAvatarIds } from './names.js'

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

async function loadGroup(id: string): Promise<Group | null> {
  const cleaned = id.trim()
  if (!cleaned) return null
  const rows = await db().select().from(groups).where(eq(groups.id, cleaned)).limit(1)
  const g = rows[0]
  if (!g) return null
  const members = await db()
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, g.id))
  return {
    id: g.id,
    name: g.name,
    inviteCode: g.inviteCode,
    createdBy: { accountId: g.createdByAccountId },
    members: members.map((m) => ({
      name: cleanPlayerName(m.name),
      joinedAt: m.joinedAt,
    })),
  }
}

async function loadAllGroups(): Promise<Group[]> {
  const groupRows = await db().select().from(groups)
  if (!groupRows.length) return []
  const memberRows = await db().select().from(groupMembers)
  const byGroup = new Map<string, GroupMember[]>()
  for (const m of memberRows) {
    const list = byGroup.get(m.groupId) ?? []
    list.push({ name: cleanPlayerName(m.name), joinedAt: m.joinedAt })
    byGroup.set(m.groupId, list)
  }
  return groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    inviteCode: g.inviteCode,
    createdBy: { accountId: g.createdByAccountId },
    members: byGroup.get(g.id) ?? [],
  }))
}

async function accountNames(accountId?: string): Promise<string[]> {
  if (!accountId) return []
  return (await namesOwnedByAccount(accountId)).map((n) => n.name)
}

export async function isGroupMember(
  group: Group,
  opts: GroupAccessOpts = {},
): Promise<boolean> {
  const names = new Set<string>()
  const player = cleanPlayerName(opts.playerName ?? '')
  if (player) names.add(player)
  for (const owned of await accountNames(opts.accountId)) names.add(owned)
  return group.members.some((m) => names.has(m.name))
}

export function isGroupOwner(group: Group, accountId?: string): boolean {
  return Boolean(accountId && group.createdBy.accountId === accountId)
}

async function canViewGroup(group: Group, opts: GroupAccessOpts = {}): Promise<boolean> {
  if ((await isGroupMember(group, opts)) || isGroupOwner(group, opts.accountId)) return true
  const invite = opts.inviteCode?.trim().toUpperCase()
  return Boolean(invite && invite === group.inviteCode)
}

export async function getGroup(id: string): Promise<Group | null> {
  return loadGroup(id)
}

export function rosterNameSet(group: Group): Set<string> {
  return new Set(group.members.map((m) => m.name).filter(Boolean))
}

/** `group=everyone` or omitted → null. Unknown/non-member → throw. */
export async function resolveBoardScope(
  groupId: string | undefined,
  opts: GroupAccessOpts = {},
): Promise<{ groupId: string; names: Set<string> } | null> {
  const id = groupId?.trim()
  if (!id || id === 'everyone') return null
  const group = await assertGroupBoardAccess(id, opts)
  return { groupId: group.id, names: rosterNameSet(group) }
}

/** Member-only. Throws 403/404. */
export async function assertGroupBoardAccess(
  id: string,
  opts: GroupAccessOpts = {},
): Promise<Group> {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!(await isGroupMember(group, opts)) && !isGroupOwner(group, opts.accountId)) {
    fail('Members only', 403, 'GROUP_FORBIDDEN')
  }
  return group
}

export async function publicGroup(
  group: Group,
  opts: GroupAccessOpts = {},
): Promise<{
  id: string
  name: string
  memberCount: number
  members: Array<GroupMember & { avatarId?: string }>
  isOwner: boolean
  isMember: boolean
  inviteCode: string | null
}> {
  const owner = isGroupOwner(group, opts.accountId)
  const member = await isGroupMember(group, opts)
  return {
    id: group.id,
    name: group.name,
    memberCount: group.members.length,
    members: await withAvatarIds(group.members),
    isOwner: owner,
    isMember: member,
    inviteCode: owner ? group.inviteCode : null,
  }
}

export async function listGroupsFor(opts: GroupAccessOpts = {}) {
  const all = await loadAllGroups()
  const out = []
  for (const g of all) {
    if ((await isGroupMember(g, opts)) || isGroupOwner(g, opts.accountId)) {
      out.push(await publicGroup(g, opts))
    }
  }
  return out
}

export async function getGroupDetail(id: string, opts: GroupAccessOpts = {}) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!(await canViewGroup(group, opts))) fail('Valid invite required', 403, 'INVITE_REQUIRED')
  return publicGroup(group, opts)
}

export async function createGroup(
  rawName: string,
  creator: { accountId: string },
  ownerName?: string,
  now = Date.now(),
) {
  const name = rawName.trim().slice(0, 32)
  if (name.length < 2) fail('Name must be at least 2 characters', 400)
  const hosted = await db()
    .select()
    .from(groups)
    .where(eq(groups.createdByAccountId, creator.accountId))
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

  await db().transaction(async (tx) => {
    await tx.insert(groups).values({
      id: group.id,
      name: group.name,
      inviteCode: group.inviteCode,
      createdByAccountId: creator.accountId,
    })
    if (members.length) {
      await tx.insert(groupMembers).values(
        members.map((m) => ({
          groupId: group.id,
          name: m.name,
          joinedAt: m.joinedAt,
        })),
      )
    }
  })

  return publicGroup(group, { accountId: creator.accountId, playerName: tag })
}

export async function joinGroup(
  id: string,
  rawName: string,
  invite: string,
  now = Date.now(),
) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  const code = invite.trim().toUpperCase()
  if (!code || code !== group.inviteCode) fail('Valid invite required', 403, 'INVITE_REQUIRED')

  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (group.members.some((m) => m.name === name)) {
    return publicGroup(group, { playerName: name })
  }
  if (group.members.length >= MAX_MEMBERS) fail('This group is full', 409, 'GROUP_FULL')

  await db().insert(groupMembers).values({
    groupId: group.id,
    name,
    joinedAt: now,
  })
  group.members.push({ name, joinedAt: now })
  return publicGroup(group, { playerName: name })
}

export async function leaveGroup(id: string, rawName: string, accountId?: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400, 'NAME_REQUIRED')
  if (!(await isGroupMember(group, { playerName: name, accountId }))) {
    fail('Not a member', 403, 'GROUP_FORBIDDEN')
  }
  if (isGroupOwner(group, accountId) && group.members.length > 1) {
    fail('Transfer or remove others before leaving as owner, or delete the group', 409, 'OWNER_LEAVE')
  }
  await db()
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, id), eq(groupMembers.name, name)))
  group.members = group.members.filter((m) => m.name !== name)
  if (group.members.length === 0 && isGroupOwner(group, accountId)) {
    await db().delete(groups).where(eq(groups.id, id))
  }
  return { ok: true }
}

export async function kickMember(id: string, accountId: string, rawName: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can remove members', 403)
  const name = cleanPlayerName(rawName)
  if (!name) fail('Name required', 400)
  await db()
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, id), eq(groupMembers.name, name)))
  group.members = group.members.filter((m) => m.name !== name)
  return publicGroup(group, { accountId })
}

export async function renameGroup(id: string, accountId: string, rawName: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can rename', 403)
  const name = rawName.trim().slice(0, 32)
  if (name.length < 2) fail('Name must be at least 2 characters', 400)
  await db().update(groups).set({ name }).where(eq(groups.id, id))
  group.name = name
  return publicGroup(group, { accountId })
}

export async function rotateInvite(id: string, accountId: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can rotate the invite', 403)
  const inviteCode = generateInviteCode()
  await db().update(groups).set({ inviteCode }).where(eq(groups.id, id))
  group.inviteCode = inviteCode
  return publicGroup(group, { accountId })
}

export async function deleteGroup(id: string, accountId: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can delete', 403)
  await db().delete(groups).where(eq(groups.id, id))
  return { ok: true }
}

export async function renamePlayerAcrossGroups(fromRaw: string, toRaw: string) {
  const from = cleanPlayerName(fromRaw)
  const to = cleanPlayerName(toRaw)
  if (!from || !to || from === to) return { updated: 0 }
  const updated = await db()
    .update(groupMembers)
    .set({ name: to })
    .where(eq(groupMembers.name, from))
    .returning({ groupId: groupMembers.groupId })
  return { updated: updated.length }
}
