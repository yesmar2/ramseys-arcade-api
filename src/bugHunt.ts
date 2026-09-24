import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { bugHuntFinds } from './db/schema.js'
import { BOARD_TZ } from './store.js'

/*
 * The daily bug hunt's finds. The site picks each day's bug and where it
 * hides (lib/bugHunt.ts there), so everyone sees the same one; this keeps who
 * caught it. A player's finds follow them to any device, and a day can say
 * how many caught its bug and where a find came in.
 *
 * The pick isn't checked here: a find names a day, a bug and a spot, and the
 * bug has to be one of the twelve. Claiming one you didn't catch only fills
 * in your own collection.
 */

/** The wanted bugs from Find the Bug, by the ids the site draws them with. */
export const HUNT_BUGS: ReadonlySet<string> = new Set([
  'bug',
  'skip',
  'dotty',
  'pickle',
  'tiger',
  'rosie',
  'ziggy',
  'honey',
  'buzz',
  'pip',
  'hopper',
  'flutter',
])

/** No find can be older than the hunt. */
const FIRST_DAY = '2026-09-20'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const SPOT = /^[a-z0-9-]{2,40}$/

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOARD_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The day on the boards' clock, as YYYY-MM-DD. */
export function huntDay(now = Date.now()): string {
  return dayFormat.format(new Date(now))
}

export type HuntFind = { day: string; bug: string; spot: string; at: number }

/** A find the site sent, if it could be one: a real day no later than tomorrow, one of the twelve. */
export function validFind(input: { day: string; bug: string; spot: string }, now = Date.now()): boolean {
  if (!DAY.test(input.day) || input.day < FIRST_DAY) return false
  // A day ahead is a clock on the other side of midnight; more than that is not a find.
  if (input.day > huntDay(now + 36 * 3_600_000)) return false
  return HUNT_BUGS.has(input.bug) && SPOT.test(input.spot)
}

/* ------------------------------------------------------------ counting --- */

const COUNT_FRESH_MS = 20_000
let counted: { day: string; count: number; at: number } | null = null

/** How many caught this day's bug. Asked on every page with the strip, so held for a few seconds. */
export async function huntCount(day: string, now = Date.now()): Promise<number> {
  if (counted && counted.day === day && now - counted.at < COUNT_FRESH_MS) return counted.count
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(bugHuntFinds)
    .where(eq(bugHuntFinds.day, day))
  const count = row?.n ?? 0
  counted = { day, count, at: now }
  return count
}

/** Where a find came in on its day: 1 for the first to catch it. */
async function placeOf(day: string, foundAt: number): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(bugHuntFinds)
    .where(and(eq(bugHuntFinds.day, day), lte(bugHuntFinds.foundAt, foundAt)))
  return Math.max(1, row?.n ?? 1)
}

/* --------------------------------------------------------- your finds --- */

export async function findsFor(accountId: string): Promise<HuntFind[]> {
  const rows = await db()
    .select()
    .from(bugHuntFinds)
    .where(eq(bugHuntFinds.accountId, accountId))
    .orderBy(asc(bugHuntFinds.day))
  return rows.map((r) => ({ day: r.day, bug: r.bug, spot: r.spot, at: r.foundAt }))
}

export type HuntReply = {
  day: string
  count: number
  you?: { finds: HuntFind[]; place: number | null }
}

/** Today, for anyone: how many caught its bug, and for a player, their finds and where theirs came in. */
export async function huntReply(accountId: string | null, now = Date.now()): Promise<HuntReply> {
  const day = huntDay(now)
  const count = await huntCount(day, now)
  if (!accountId) return { day, count }
  const finds = await findsFor(accountId)
  const today = finds.find((f) => f.day === day)
  return { day, count, you: { finds, place: today ? await placeOf(day, today.at) : null } }
}

/**
 * Keep the finds a player's device sent: a catch just made, or the ones it
 * made before they signed in. A day already on record keeps its first find.
 * Today's is timed by the server, so where it came in is fair.
 */
export async function recordFinds(
  accountId: string,
  input: { day: string; bug: string; spot: string; at?: number }[],
  now = Date.now(),
): Promise<HuntReply> {
  const today = huntDay(now)
  const rows = input
    .filter((f) => validFind(f, now))
    .map((f) => ({
      accountId,
      day: f.day,
      bug: f.bug,
      spot: f.spot,
      // Only a past day takes the device's word for when; today's is now.
      foundAt: f.day < today && f.at && f.at > 0 && f.at < now ? Math.floor(f.at) : now,
    }))
  if (rows.length) {
    const added = await db().insert(bugHuntFinds).values(rows).onConflictDoNothing().returning({ day: bugHuntFinds.day })
    // A new find today changes the count everyone sees.
    if (added.some((r) => r.day === today)) counted = null
  }
  return huntReply(accountId, now)
}
