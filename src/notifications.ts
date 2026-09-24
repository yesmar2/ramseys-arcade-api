import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { friendRequests, notifications } from './db/schema.js'
import { resolveAvatarId } from './names.js'

/**
 * Everything the arcade can tell a player.
 *
 * Only the match kinds and a beaten challenge are ever delivered to a device —
 * see `PUSHABLE`. The rest live in the inbox, where they cost the player
 * nothing to miss.
 */
export type NotificationKind =
  | 'match-open'
  | 'match-closing'
  | 'record-lost'
  | 'friend-request'
  | 'friend-accepted'
  | 'trophy'
  | 'event-result'
  | 'challenge-beaten'
  | 'challenge-taken'

/**
 * The push allow-list.
 *
 * A bracket match has a clock and a forfeit on the other side of it, so missing
 * one costs a player their run. A beaten challenge is the other exception: it
 * is a friend answering something the player sent them, and the answer back
 * is the whole point. Nothing else goes to a phone: a beaten record is still
 * beaten when you next open the app, and telling someone about it on their
 * phone buys them nothing they can act on. The daily cap and quiet hours in
 * push.ts hold for every kind.
 */
export const PUSHABLE: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'match-open',
  'match-closing',
  'challenge-beaten',
])

export const MATCH_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'match-open',
  'match-closing',
])

/**
 * What the inbox needs to draw a row beyond its words: whose face, which
 * game, what its button does. Every field is optional; a row without one is
 * drawn from its kind alone.
 */
export type NotificationMeta = {
  /** The other player: whose avatar the row shows. */
  actor?: string
  /** The game it's about, drawn in the corner of the face. */
  game?: string
  /** Where the row's main button goes, when that isn't the row's own link. */
  playHref?: string
  /** A bracket match's deadline, for its countdown. */
  endsAt?: number
  eventId?: string
  matchId?: string
  /** The trophy it announces. */
  trophy?: { period: 'weekly' | 'monthly' | 'event' | 'hunt'; rank: number }
  /** Flair it unlocked, for the row to offer to put on. */
  ring?: string
  pin?: string
  /** An event finished below first: where, and out of how many. */
  place?: number
  field?: number
}

/** What a list hands the app on top of what is stored: the actor's avatar, a live request to answer. */
export type ListedMeta = NotificationMeta & { actorAvatarId?: string; requestId?: string }

export type NotificationRow = {
  id: string
  accountId: string
  kind: NotificationKind
  title: string
  body: string | null
  href: string | null
  digestKey: string | null
  count: number
  createdAt: number
  updatedAt: number
  readAt: number | null
  meta: NotificationMeta | null
  resolvedAt: number | null
  pushedAt: number | null
}

function newId() {
  return `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `YYYYMMDD` in UTC. */
export function dayKey(now: number): number {
  const d = new Date(now)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

export type NotifyInput = {
  accountId: string
  kind: NotificationKind
  title: string
  body?: string | null
  href?: string | null
  meta?: NotificationMeta | null
  /**
   * The one thing this row is about (a match, a record, a friend). Telling
   * the player about the same thing again updates their row instead of
   * adding another, and only brings it back as unread when what it says has
   * changed.
   */
  digestKey?: string | null
  /**
   * Leave a row already filed under this key exactly as it is. For news that
   * happens once (a match opening, a result) and would otherwise be told
   * again by every sweep that finds it still true.
   */
  once?: boolean
  now?: number
}

type Content = Pick<NotificationRow, 'kind' | 'title' | 'body' | 'href' | 'meta' | 'digestKey'>

function sameContent(row: NotificationRow, next: Content) {
  return (
    row.kind === next.kind &&
    row.title === next.title &&
    (row.body ?? null) === (next.body ?? null) &&
    (row.href ?? null) === (next.href ?? null) &&
    JSON.stringify(row.meta ?? null) === JSON.stringify(next.meta ?? null)
  )
}

async function rowByKey(accountId: string, digestKey: string): Promise<NotificationRow | null> {
  const [row] = await db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.accountId, accountId), eq(notifications.digestKey, digestKey)))
    .limit(1)
  return (row as NotificationRow | undefined) ?? null
}

/**
 * File one notification.
 *
 * Returns the row, whether this call created it, and whether it changed what
 * the player sees. Callers that also push only care about `created`: an
 * update is a newer version of something the player was already told.
 */
export async function notify(
  input: NotifyInput,
): Promise<{ row: NotificationRow; created: boolean; changed: boolean }> {
  const now = input.now ?? Date.now()
  const content: Content = {
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
    meta: input.meta ?? null,
    digestKey: input.digestKey ?? null,
  }

  const insert = () =>
    db()
      .insert(notifications)
      .values({ id: newId(), accountId: input.accountId, ...content, count: 1, createdAt: now, updatedAt: now })

  if (!content.digestKey) {
    const [row] = await insert().returning()
    return { row: row as NotificationRow, created: true, changed: true }
  }

  const existing = await rowByKey(input.accountId, content.digestKey)
  if (!existing) {
    // Two filings at once: the loser finds the winner's row and leaves it be.
    const [row] = await insert().onConflictDoNothing().returning()
    if (row) return { row: row as NotificationRow, created: true, changed: true }
    const winner = await rowByKey(input.accountId, content.digestKey)
    if (winner) return { row: winner, created: false, changed: false }
    throw new Error('Notification vanished while filing')
  }

  if (input.once || sameContent(existing, content)) {
    return { row: existing, created: false, changed: false }
  }

  const [row] = await db()
    .update(notifications)
    .set({
      kind: content.kind,
      title: content.title,
      body: content.body,
      href: content.href,
      meta: content.meta,
      count: sql`${notifications.count} + 1`,
      updatedAt: now,
      // What it says has changed, so the player hasn't seen this version.
      readAt: null,
      resolvedAt: null,
    })
    .where(eq(notifications.id, existing.id))
    .returning()
  return { row: row as NotificationRow, created: false, changed: true }
}

/** Nothing left to do about it: say how it ended, and stop asking. */
export async function resolveNotification(
  accountId: string,
  digestKey: string,
  next: { title: string; body?: string | null; href?: string | null; meta?: NotificationMeta | null },
  now = Date.now(),
) {
  await db()
    .update(notifications)
    .set({
      title: next.title,
      body: next.body ?? null,
      ...(next.href !== undefined ? { href: next.href } : {}),
      ...(next.meta !== undefined ? { meta: next.meta } : {}),
      resolvedAt: now,
    })
    .where(and(eq(notifications.accountId, accountId), eq(notifications.digestKey, digestKey)))
}

/** Take a notification back: the thing it asked about is gone. */
export async function withdrawNotification(accountId: string, digestKey: string) {
  await db()
    .delete(notifications)
    .where(and(eq(notifications.accountId, accountId), eq(notifications.digestKey, digestKey)))
}

export async function markPushed(id: string, now = Date.now()) {
  await db().update(notifications).set({ pushedAt: now }).where(eq(notifications.id, id))
}

/* ------------------------------------------------------------- reading --- */

const TAG = /^[A-Z0-9]{2,12}$/

/** Who and what a row is about, for rows filed before `meta` existed: the tag leads or ends the title. */
function readMeta(row: NotificationRow): NotificationMeta {
  const meta: NotificationMeta = { ...(row.meta ?? {}) }
  const words = row.title.split(/\s+/)
  const tag = (w: string | undefined) => (w && TAG.test(w) ? w : undefined)
  if (!meta.actor) {
    if (row.kind === 'match-open' || row.kind === 'match-closing') meta.actor = tag(words[words.length - 1])
    else if (row.kind !== 'trophy' && row.kind !== 'event-result') meta.actor = tag(words[0])
  }
  if (!meta.game && row.href) {
    const m = /^#?\/(?:c|games|records)\/([a-z]+)/.exec(row.href)
    if (m) meta.game = m[1]
  }
  if (row.kind === 'trophy' && !meta.trophy) meta.trophy = { period: 'event', rank: 1 }
  return meta
}

/** Links filed as `#/…` before the site moved to paths, and two that never led anywhere. */
function currentHref(row: NotificationRow, meta: NotificationMeta): string | null {
  const href = row.href
  if (!href) return null
  if (href === '#/friends') {
    return meta.actor ? `/rank/${encodeURIComponent(meta.actor)}/week` : '/rank/week?focus=friends'
  }
  if (href === '#/rank') return '/rank/all?focus=trophies'
  if (href.startsWith('#/')) return href.slice(1)
  return href
}

/** Words filed before the site called it a shelf, said the way it says them now. */
const OLD_BODIES: Record<string, string> = {
  'A trophy has been added to your case.': 'The cup is on your shelf.',
  'You are now friends.': 'See how you compare on their card.',
}

export type ListedNotification = Omit<NotificationRow, 'accountId' | 'meta' | 'pushedAt' | 'digestKey'> & {
  meta: ListedMeta
}

export async function listNotifications(accountId: string, limit = 50): Promise<ListedNotification[]> {
  const rows = (await db()
    .select()
    .from(notifications)
    .where(eq(notifications.accountId, accountId))
    .orderBy(desc(notifications.updatedAt))
    .limit(Math.min(100, Math.max(1, Math.floor(limit))))) as NotificationRow[]

  // A request is answered from the row itself, so the row needs the live request's id.
  const asks = rows.some((r) => r.kind === 'friend-request' && !r.resolvedAt)
  const now = Date.now()
  const pending = asks
    ? await db()
        .select({ id: friendRequests.id, from: friendRequests.fromAccountId, expiresAt: friendRequests.expiresAt })
        .from(friendRequests)
        .where(and(eq(friendRequests.toAccountId, accountId), eq(friendRequests.status, 'pending')))
    : []
  const requestFrom = new Map(pending.filter((p) => p.expiresAt > now).map((p) => [p.from, p.id]))

  return Promise.all(
    rows.map(async (row) => {
      const meta: ListedMeta = readMeta(row)
      if (meta.actor) meta.actorAvatarId = await resolveAvatarId(meta.actor)
      if (row.kind === 'friend-request' && !row.resolvedAt && row.digestKey?.startsWith('friend-request:')) {
        const id = requestFrom.get(row.digestKey.slice('friend-request:'.length))
        if (id) meta.requestId = id
      }
      const { accountId: _account, pushedAt: _pushed, digestKey: _key, ...rest } = row
      const body = row.body ? (OLD_BODIES[row.body] ?? row.body) : null
      return { ...rest, body, href: currentHref(row, meta), meta }
    }),
  )
}

export async function unreadCount(accountId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)))
  return row?.n ?? 0
}

/** Mark specific notifications read, or the whole inbox when `ids` is omitted. */
export async function markRead(accountId: string, ids?: string[], now = Date.now()) {
  const scope = ids?.length
    ? and(eq(notifications.accountId, accountId), inArray(notifications.id, ids))
    : and(eq(notifications.accountId, accountId), isNull(notifications.readAt))
  await db().update(notifications).set({ readAt: now }).where(scope)
}
