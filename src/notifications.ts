import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { notifications } from './db/schema.js'

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
  | 'board-passed'
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

export type NotificationRow = {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  href: string | null
  count: number
  createdAt: number
  updatedAt: number
  readAt: number | null
}

function newId() {
  return `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `YYYYMMDD` in UTC — the grain digest keys collapse on. */
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
  /**
   * Repeat suppression. Two notifications sharing a key collapse into one row
   * with a count, rather than stacking. Include the day to let a new day start
   * a fresh row (`record-lost:20260916`).
   */
  digestKey?: string | null
  now?: number
}

/**
 * File one notification, folding it into an existing digest when it repeats.
 *
 * Returns the row, and whether this call created it. Callers that also want to
 * push care about the difference: a fold is a louder version of something the
 * player was already told about, not news.
 */
export async function notify(
  input: NotifyInput,
): Promise<{ row: NotificationRow; created: boolean }> {
  const now = input.now ?? Date.now()
  const base = {
    accountId: input.accountId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
    digestKey: input.digestKey ?? null,
    updatedAt: now,
  }

  if (!input.digestKey) {
    const [row] = await db()
      .insert(notifications)
      .values({ id: newId(), ...base, count: 1, createdAt: now })
      .returning()
    return { row: row as NotificationRow, created: true }
  }

  /*
   * An upsert keeps this a single round trip and safe under concurrent writes:
   * whoever loses the race bumps the winner's row instead of erroring on the
   * unique index.
   */
  const [row] = await db()
    .insert(notifications)
    .values({ id: newId(), ...base, count: 1, createdAt: now })
    .onConflictDoUpdate({
      target: [notifications.accountId, notifications.digestKey],
      set: {
        title: base.title,
        body: base.body,
        href: base.href,
        count: sql`${notifications.count} + 1`,
        updatedAt: now,
        // A repeat makes it unread again — the player has not seen this version.
        readAt: null,
      },
    })
    .returning()

  return { row: row as NotificationRow, created: (row as NotificationRow).count === 1 }
}

export async function listNotifications(
  accountId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  const rows = await db()
    .select()
    .from(notifications)
    .where(eq(notifications.accountId, accountId))
    .orderBy(desc(notifications.updatedAt))
    .limit(Math.min(100, Math.max(1, Math.floor(limit))))
  return rows as NotificationRow[]
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
