import { eq, inArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { notificationSettings } from './db/schema.js'
import type { NotificationKind, NotificationMeta } from './notifications.js'

/*
 * What each player hears about, and how: the site's Notifications settings page.
 *
 * Every note the arcade files has a topic, which is its kind, except that a friend beating your lap on
 * Today's Track is apart from the hole and the Wanted. Each topic has a level:
 *   - 'push' files the note in the inbox and alerts the player's devices where alerts are on.
 *   - 'inbox' only files it.
 *   - 'off' drops it.
 * notify() asks before filing anything, and push.ts asks again before sending. A player's row keeps only
 * what they've chosen, so a topic they never touched follows the defaults here.
 */

export type NotificationLevel = 'push' | 'inbox' | 'off'

export type NotificationTopic = NotificationKind | 'today-lap'

export type NotificationLevels = Record<NotificationTopic, NotificationLevel>

/**
 * Where each topic goes until the player says otherwise.
 *
 * By default, only what a player can act on buzzes a phone:
 *   - A bracket match has a clock, and a forfeit on the other side of it.
 *   - A beaten challenge is a friend answering something the player sent them.
 *   - A beaten lap on Today's Track can be won back the same day.
 *   - So can a place in a racing daily's top three, and its tickets.
 *   - A Dailies streak about to end is kept by playing before the day does.
 * The rest wait in the inbox. A beaten record is still beaten when you next open the app.
 */
export const DEFAULT_LEVELS: Readonly<NotificationLevels> = {
  'match-open': 'push',
  'match-closing': 'push',
  'event-result': 'inbox',
  'friend-request': 'inbox',
  'friend-accepted': 'inbox',
  'challenge-beaten': 'push',
  'challenge-taken': 'inbox',
  'today-lap': 'push',
  'today-beaten': 'inbox',
  'streak-risk': 'push',
  'podium-lost': 'push',
  'record-lost': 'inbox',
  trophy: 'inbox',
}

const LEVELS: ReadonlySet<string> = new Set<NotificationLevel>(['push', 'inbox', 'off'])

export function isTopic(value: string): value is NotificationTopic {
  return Object.hasOwn(DEFAULT_LEVELS, value)
}

export function isLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string' && LEVELS.has(value)
}

/**
 * A note's topic: its kind, except a friend beating your lap on Today's Track or your run on Today's Course,
 * Today's Cave or Today's Hills, which is its own: those you can still take back the same day.
 */
export function topicOf(kind: NotificationKind, meta?: NotificationMeta | null): NotificationTopic {
  const racing = meta?.game === 'hotlap' || meta?.game === 'marblerun' || meta?.game === 'lander' || meta?.game === 'swoop'
  return kind === 'today-beaten' && racing ? 'today-lap' : kind
}

/** The player's choices over the defaults, leaving out anything kept that is no longer a topic or a level. */
function withDefaults(stored: unknown): NotificationLevels {
  const levels: NotificationLevels = { ...DEFAULT_LEVELS }
  if (stored && typeof stored === 'object') {
    for (const [topic, level] of Object.entries(stored)) {
      if (isTopic(topic) && isLevel(level)) levels[topic] = level
    }
  }
  return levels
}

export async function levelsFor(accountId: string): Promise<NotificationLevels> {
  const [row] = await db()
    .select({ levels: notificationSettings.levels })
    .from(notificationSettings)
    .where(eq(notificationSettings.accountId, accountId))
    .limit(1)
  return withDefaults(row?.levels)
}

/** Several players' levels at once, for the sweep that sends what quiet hours held back. */
export async function levelsForAccounts(accountIds: readonly string[]): Promise<Map<string, NotificationLevels>> {
  const out = new Map<string, NotificationLevels>()
  if (!accountIds.length) return out
  const rows = await db()
    .select({ accountId: notificationSettings.accountId, levels: notificationSettings.levels })
    .from(notificationSettings)
    .where(inArray(notificationSettings.accountId, [...accountIds]))
  const stored = new Map(rows.map((r) => [r.accountId, r.levels]))
  for (const id of accountIds) out.set(id, withDefaults(stored.get(id)))
  return out
}

/**
 * Change some of a player's choices, and keep the rest as they were.
 *
 * The page saves each change as it's made, so two can arrive together. The database merges them rather
 * than one overwriting the other.
 */
export async function saveLevels(
  accountId: string,
  changes: Partial<NotificationLevels>,
  now = Date.now(),
): Promise<NotificationLevels> {
  await db()
    .insert(notificationSettings)
    .values({ accountId, levels: changes, updatedAt: now })
    .onConflictDoUpdate({
      target: notificationSettings.accountId,
      set: { levels: sql`${notificationSettings.levels} || excluded.levels`, updatedAt: now },
    })
  return levelsFor(accountId)
}
