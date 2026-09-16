import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { groupMembers, groups } from './db/schema.js'
import { cleanPlayerName, getClaim, namesOwnedByAccount, withAvatarIds } from './names.js'

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

/*
 * There are a handful of groups and a few dozen memberships, and every
 * scoped board request needs one of them. Load them all in two queries and
 * keep them for a minute; any write through this module drops the copy.
 */
const GROUPS_TTL_MS = 60_000
let groupsCache: { at: number; groups: Group[] } | null = null
let groupsLoading: Promise<Group[]> | null = null

export function invalidateGroupsCache() {
  groupsCache = null
}

async function loadGroup(id: string): Promise<Group | null> {
  const cleaned = id.trim()
  if (!cleaned) return null
  const g = (await loadAllGroups()).find((x) => x.id === cleaned)
  // A copy, because callers edit the group they are working on.
  return g ? { ...g, members: g.members.map((m) => ({ ...m })) } : null
}

async function loadAllGroups(): Promise<Group[]> {
  if (groupsCache && Date.now() - groupsCache.at < GROUPS_TTL_MS) return groupsCache.groups
  if (groupsLoading) return groupsLoading
  groupsLoading = loadAllGroupsFromDb()
    .then((list) => {
      groupsCache = { at: Date.now(), groups: list }
      return list
    })
    .finally(() => {
      groupsLoading = null
    })
  return groupsLoading
}

async function loadAllGroupsFromDb(): Promise<Group[]> {
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

/**
 * Which tag on the roster belongs to the account that owns the group.
 *
 * The viewer's own `isOwner` says nothing about who the host is when the
 * viewer is not them, and the roster had been guessing — labelling whoever
 * joined first, which is not the same person.
 */
export async function groupOwnerName(group: Group): Promise<string | null> {
  const owned = new Set(await accountNames(group.createdBy.accountId))
  return group.members.find((m) => owned.has(m.name))?.name ?? null
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
  ownerName: string | null
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
    ownerName: await groupOwnerName(group),
    inviteCode: owner ? group.inviteCode : null,
  }
}

export async function listGroupsFor(opts: GroupAccessOpts = {}) {
  const all = await loadAllGroups()
  // Work out the viewer's tags once, not once per group.
  const names = new Set<string>()
  const player = cleanPlayerName(opts.playerName ?? '')
  if (player) names.add(player)
  for (const owned of await accountNames(opts.accountId)) names.add(owned)
  const out = []
  for (const g of all) {
    const member = g.members.some((m) => names.has(m.name))
    const owner = isGroupOwner(g, opts.accountId)
    if (!member && !owner) continue
    out.push({
      id: g.id,
      name: g.name,
      memberCount: g.members.length,
      members: await withAvatarIds(g.members),
      isOwner: owner,
      isMember: member,
      ownerName: await groupOwnerName(g),
      inviteCode: owner ? g.inviteCode : null,
    })
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

  /*
   * The host joins their own roster, and the server works out which tag
   * rather than trusting whatever the client last used. A group whose owner
   * is not on it has no host to label and no way to leave — and it happened
   * whenever the caller sent no tag at all.
   */
  const requested = cleanPlayerName(ownerName ?? '')
  const owned = await accountNames(creator.accountId)
  const tag = requested && owned.includes(requested) ? requested : (owned[0] ?? requested)

  const members: GroupMember[] = []
  if (tag) members.push({ name: tag, joinedAt: now })

  const group: Group = {
    id: uid(),
    name,
    inviteCode: generateInviteCode(),
    createdBy: { accountId: creator.accountId },
    members,
  }

  invalidateGroupsCache()
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

  invalidateGroupsCache()
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
  invalidateGroupsCache()
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
  invalidateGroupsCache()
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
  invalidateGroupsCache()
  await db().update(groups).set({ name }).where(eq(groups.id, id))
  group.name = name
  return publicGroup(group, { accountId })
}

/**
 * Hand the group to another member.
 *
 * A group made from the wrong account is otherwise stuck: only the owner can
 * invite, rename or rotate the code, and there was no way to move that
 * without rebuilding the roster somewhere else.
 */
export async function transferGroup(id: string, accountId: string, rawName: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can hand the group over', 403)

  const toName = cleanPlayerName(rawName)
  if (!toName) fail('Gamer tag required', 400, 'NAME_REQUIRED')
  if (!group.members.some((m) => m.name === toName)) {
    fail(`${toName} is not in this group`, 404, 'NOT_A_MEMBER')
  }

  // The new host has to be an account, or nobody could host it afterwards.
  const claim = await getClaim(toName)
  if (!claim?.accountId) {
    fail(`${toName} has not signed in yet, so they cannot host`, 409, 'NOT_AN_ACCOUNT')
  }
  if (claim.accountId === accountId) return publicGroup(group, { accountId })

  invalidateGroupsCache()
  await db()
    .update(groups)
    .set({ createdByAccountId: claim.accountId })
    .where(eq(groups.id, id))
  group.createdBy = { accountId: claim.accountId }
  return publicGroup(group, { accountId })
}

export async function rotateInvite(id: string, accountId: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can rotate the invite', 403)
  const inviteCode = generateInviteCode()
  invalidateGroupsCache()
  await db().update(groups).set({ inviteCode }).where(eq(groups.id, id))
  group.inviteCode = inviteCode
  return publicGroup(group, { accountId })
}

export async function deleteGroup(id: string, accountId: string) {
  const group = await getGroup(id)
  if (!group) fail('Group not found', 404, 'GROUP_NOT_FOUND')
  if (!isGroupOwner(group, accountId)) fail('Only the owner can delete', 403)
  invalidateGroupsCache()
  await db().delete(groups).where(eq(groups.id, id))
  return { ok: true }
}

export async function renamePlayerAcrossGroups(fromRaw: string, toRaw: string) {
  const from = cleanPlayerName(fromRaw)
  const to = cleanPlayerName(toRaw)
  if (!from || !to || from === to) return { updated: 0 }
  invalidateGroupsCache()
  const updated = await db()
    .update(groupMembers)
    .set({ name: to })
    .where(eq(groupMembers.name, from))
    .returning({ groupId: groupMembers.groupId })
  return { updated: updated.length }
}
