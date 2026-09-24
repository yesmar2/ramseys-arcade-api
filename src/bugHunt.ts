import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { bugHuntFinds } from './db/schema.js'
import { invalidateFlair } from './flair.js'
import { namesOwnedByAccount } from './names.js'
import { BOARD_TZ } from './store.js'
import { awardHuntSet } from './trophies.js'

/*
 * The daily bug hunt's finds. The site picks each day's bug and where it
 * hides (lib/bugHunt.ts there), so everyone sees the same one; this keeps who
 * caught it. A player's finds follow them to any device, and a day can say
 * how many caught its bug and where a find came in.
 *
 * Finds come in two kinds. Any find names a real day and one of the twelve,
 * and fills in the player's collection. A find counts toward a month's set
 * only if it reached the API on its own day and names that day's bug. So the
 * API picks the bug exactly as the site does, and a backlog a device sends
 * up later never puts a set on the shelf.
 */

/** The wanted bugs from Find the Bug, in the site's order: the order is part of the pick. */
export const HUNT_BUG_ORDER = [
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
] as const

const HUNT_BUGS: ReadonlySet<string> = new Set(HUNT_BUG_ORDER)
export const SET_SIZE = HUNT_BUG_ORDER.length

/** No find can be older than the hunt. */
const FIRST_DAY = '2026-09-20'
/** From this day each month's bugs come round in shuffles of their own; see bugForDay. */
const MONTHLY_FROM = '2026-10-01'
/** The first set runs from the hunt's launch to the end of October. */
const FIRST_SET = '2026-10'
/** A find made just before midnight and sent just after still counts for its day. */
const MIDNIGHT_GRACE_MS = 10 * 60_000

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

/* ------------------------------------------------------------ the pick --- */

// The same hash and generator as the site's lib/seededRandom.ts: a find only counts when both pick the same bug.
function hashString(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(list: readonly T[], key: string): T[] {
  const rand = mulberry32(hashString(key))
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(2026, 0, 1)) / 86_400_000)
}

/**
 * The day's bug, picked exactly as the site picks it. From October, each
 * month starts the rotation afresh: days 1 to 12 are one shuffle of the
 * twelve, 13 to 24 another, and the rest of the month part of a third, so
 * every bug comes round two or three times a month. Before that, a running
 * shuffle of twelve days at a time.
 */
export function bugForDay(day: string): string {
  if (day >= MONTHLY_FROM) {
    const d = Number(day.slice(8, 10))
    const block = Math.floor((d - 1) / SET_SIZE)
    return shuffled(HUNT_BUG_ORDER, `bugs:${day.slice(0, 7)}:${block}`)[(d - 1) % SET_SIZE]!
  }
  const n = dayNumber(day)
  const order = shuffled(HUNT_BUG_ORDER, `bugs:${Math.floor(n / SET_SIZE)}`)
  return order[((n % SET_SIZE) + SET_SIZE) % SET_SIZE]!
}

/** The set a day's find goes toward: its own month, with the hunt's first week in October's. */
export function setKeyFor(day: string): string {
  return day < MONTHLY_FROM ? FIRST_SET : day.slice(0, 7)
}

/* ---------------------------------------------------------- the finds --- */

export type HuntFind = { day: string; bug: string; spot: string; at: number; counted: boolean }

/** A find the site sent, if it could be one: a real day no later than tomorrow, one of the twelve. */
export function validFind(input: { day: string; bug: string; spot: string }, now = Date.now()): boolean {
  if (!DAY.test(input.day) || input.day < FIRST_DAY) return false
  // A day ahead is a clock on the other side of midnight; more than that is not a find.
  if (input.day > huntDay(now + 36 * 3_600_000)) return false
  return HUNT_BUGS.has(input.bug) && SPOT.test(input.spot)
}

/** Whether a find for this day, sent now, counts toward its set. */
function counts(find: { day: string; bug: string }, now: number): boolean {
  const onItsDay = find.day === huntDay(now) || find.day === huntDay(now - MIDNIGHT_GRACE_MS)
  return onItsDay && find.bug === bugForDay(find.day)
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
  return rows.map((r) => ({ day: r.day, bug: r.bug, spot: r.spot, at: r.foundAt, counted: r.counted }))
}

/** The bugs that count toward a set, from a player's finds. */
function setBugs(finds: HuntFind[], key: string): Set<string> {
  return new Set(finds.filter((f) => f.counted && setKeyFor(f.day) === key).map((f) => f.bug))
}

/** A set just completed by a find: which, and what came with it. */
export type HuntCompleted = {
  /** YYYY-MM. */
  key: string
  /** On the shelf: false for an account with no tag to put it under. */
  shelved: boolean
  /** The first set ever, which unlocks the bug net pin. */
  pin: boolean
}

export type HuntReply = {
  day: string
  count: number
  you?: {
    finds: HuntFind[]
    place: number | null
    /** This month's set: the bugs that count toward it. */
    set: { key: string; bugs: string[] }
  }
  /** Only on the reply to the find that completed a set. */
  completed?: HuntCompleted
}

/** Today, for anyone: how many caught its bug, and for a player, their finds, their place, and their set. */
export async function huntReply(accountId: string | null, now = Date.now()): Promise<HuntReply> {
  const day = huntDay(now)
  const count = await huntCount(day, now)
  if (!accountId) return { day, count }
  const finds = await findsFor(accountId)
  await shelveMissedSets(accountId, finds, now)
  const today = finds.find((f) => f.day === day)
  const key = setKeyFor(day)
  return {
    day,
    count,
    you: {
      finds,
      place: today ? await placeOf(day, today.at) : null,
      set: { key, bugs: [...setBugs(finds, key)] },
    },
  }
}

/** Complete sets known to be on an account's shelf, so a reply doesn't look again. */
const shelvedSets = new Map<string, Set<string>>()

/**
 * Put a complete set on the shelf of the tag the account plays as, with the
 * flair it unlocks. Null when it was already there.
 */
async function shelveSet(accountId: string, key: string, finds: HuntFind[], now: number): Promise<HuntCompleted | null> {
  const [tag] = await namesOwnedByAccount(accountId)
  if (!tag) return { key, shelved: false, pin: false }
  const award = await awardHuntSet({
    accountId,
    name: tag.name,
    periodKey: Number(key.replace('-', '')),
    finds: finds.filter((f) => f.counted && setKeyFor(f.day) === key).length,
    awardedAt: now,
  })
  const known = shelvedSets.get(accountId) ?? new Set<string>()
  shelvedSets.set(accountId, known.add(key))
  if (!award.created) return null
  // So "wear the pin" works straight away rather than after the flair cache runs out.
  invalidateFlair(tag.name)
  return { key, shelved: true, pin: award.firstSet }
}

/** A find has just brought a set to all twelve. Nothing if it was complete before this find. */
async function completeSet(accountId: string, key: string, before: Set<string>, now: number): Promise<HuntCompleted | null> {
  const finds = await findsFor(accountId)
  if (setBugs(finds, key).size < SET_SIZE || before.size >= SET_SIZE) return null
  return shelveSet(accountId, key, finds, now)
}

/**
 * A set completed while the account had no tag, or whose trophy didn't go
 * through, goes on the shelf with the next reply: once there's a tag to put
 * it under, the inbox tells them.
 */
async function shelveMissedSets(accountId: string, finds: HuntFind[], now: number): Promise<void> {
  const known = shelvedSets.get(accountId)
  const keys = new Set(finds.filter((f) => f.counted).map((f) => setKeyFor(f.day)))
  for (const key of keys) {
    if (known?.has(key) || setBugs(finds, key).size < SET_SIZE) continue
    await shelveSet(accountId, key, finds, now).catch(() => null)
  }
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
      counted: counts(f, now),
    }))

  let completed: HuntCompleted | null = null
  if (rows.length) {
    // What each set held before this, so a find is only called the one that completed it if it was.
    const before = await findsFor(accountId)
    const added = await db()
      .insert(bugHuntFinds)
      .values(rows)
      .onConflictDoNothing()
      .returning({ day: bugHuntFinds.day, counted: bugHuntFinds.counted })
    // A new find today changes the count everyone sees.
    if (added.some((r) => r.day === today)) counted = null
    const sets = new Set(added.filter((r) => r.counted).map((r) => setKeyFor(r.day)))
    for (const key of sets) {
      // A trophy that doesn't go through is put there by a later reply; the find is kept either way.
      completed = (await completeSet(accountId, key, setBugs(before, key), now).catch(() => null)) ?? completed
    }
  }

  const reply = await huntReply(accountId, now)
  return completed ? { ...reply, completed } : reply
}
