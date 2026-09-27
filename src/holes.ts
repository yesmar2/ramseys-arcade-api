import { and, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm'
import { ACECHASE_FIRST_DAY, ACECHASE_HOLE_NAMES } from './courseNames.js'
import { db } from './db/client.js'
import { dailyHoleResults, holeResults } from './db/schema.js'
import { boardDateKey, isDeviceType, type DeviceType, type GameSlug } from './store.js'

/*
 * Hole records. Every Ace Chase hole keeps a board of its own for good. On its day a hole is Today's Hole
 * (dailyHole.ts): an account's first result that day is its result, on the day's board, with its tickets,
 * which close at midnight. After that the hole stays open: an account with no result on it yet can play
 * it for one, and its first bullseye there goes on the hole's board, here. The board is the hole's day's
 * results and every one since, fewest tries first, a tie going to the earlier. Nothing here feeds the day's
 * board, the standings, events or the day's tickets, and nothing that reads those reads this.
 *
 * As on its day, the tries are the site's word, and an account has one result a hole, its first: one from
 * the hole's day stands, and anything after it is practice.
 */

/** The games whose holes keep boards of their own. */
export const HOLE_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['acechase'])

const DAY = /^\d{4}-\d{2}-\d{2}$/

const dayUtc = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/** Today on the boards' clock, YYYY-MM-DD: the day Today's Hole is (dailyHole.ts huntDay keeps the same clock). */
export function holeToday(now = Date.now()): string {
  const key = boardDateKey(now)
  return `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`
}

/** How many holes the plan has. */
export function holeCount(): number {
  return ACECHASE_HOLE_NAMES.length
}

/** A hole's number: 1 on the first day. */
export function holeNumber(day: string): number {
  return Math.round((dayUtc(day) - dayUtc(ACECHASE_FIRST_DAY)) / 86_400_000) + 1
}

/** A hole's day, YYYY-MM-DD, from its number. */
export function holeDay(n: number): string {
  return new Date(dayUtc(ACECHASE_FIRST_DAY) + (n - 1) * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Where a hole stands today: 'past' once its day has gone (a result on it comes here), 'today' while it's
 * Today's Hole (a result goes to dailyHole.ts), 'ahead' before its day, or 'none' for a day with no hole.
 */
export function holeState(day: string, now = Date.now()): 'past' | 'today' | 'ahead' | 'none' {
  if (!DAY.test(day)) return 'none'
  const n = holeNumber(day)
  if (!Number.isInteger(n) || n < 1 || n > holeCount() || holeDay(n) !== day) return 'none'
  const today = holeToday(now)
  if (day === today) return 'today'
  return day < today ? 'past' : 'ahead'
}

/** A result on a hole's board: whose, in how many tries, when, and on what. */
export type HoleEntry = { name: string; tries: number; at: number; device: DeviceType; accountId: string }

const order = (a: HoleEntry, b: HoleEntry) => a.tries - b.tries || a.at - b.at

/** Each tag once, at its best, fewest tries first and the earlier of two the same. */
function merge(rows: HoleEntry[]): HoleEntry[] {
  const best = new Map<string, HoleEntry>()
  for (const row of rows) {
    const had = best.get(row.name)
    if (!had || order(row, had) < 0) best.set(row.name, row)
  }
  return [...best.values()].sort(order)
}

type Row = { day: string } & HoleEntry

/** The results on holes from `from` to `to`: each day's with a tag, and every one since. */
async function resultsBetween(game: GameSlug, from: string, to: string): Promise<Row[]> {
  const onDay = await db()
    .select({
      day: dailyHoleResults.day,
      name: dailyHoleResults.name,
      tries: dailyHoleResults.tries,
      at: dailyHoleResults.solvedAt,
      accountId: dailyHoleResults.accountId,
    })
    .from(dailyHoleResults)
    .where(and(gte(dailyHoleResults.day, from), lte(dailyHoleResults.day, to), isNotNull(dailyHoleResults.name)))
  const later = await db()
    .select({
      day: holeResults.day,
      name: holeResults.name,
      tries: holeResults.tries,
      at: holeResults.at,
      accountId: holeResults.accountId,
      device: holeResults.device,
    })
    .from(holeResults)
    .where(and(eq(holeResults.game, game), gte(holeResults.day, from), lte(holeResults.day, to)))
  return [
    // The day's results don't say what they were played on.
    ...onDay.map((r) => ({ day: r.day, name: r.name!, tries: r.tries, at: r.at, device: 'desktop' as DeviceType, accountId: r.accountId })),
    ...later.map((r) => ({ ...r, device: isDeviceType(r.device) ? r.device : ('desktop' as DeviceType) })),
  ]
}

/** A hole's board: its day's results and every one since, fewest tries first. */
export async function holeBoard(game: GameSlug, day: string): Promise<HoleEntry[]> {
  return merge(await resultsBetween(game, day, day))
}

export type HoleRecord = {
  n: number
  /** Its day, YYYY-MM-DD. */
  day: string
  /** How many have a result on it. */
  players: number
  record: HoleEntry | null
  /** `name`'s result on it and their place, if they have one. */
  you: { tries: number; place: number } | null
}

/** Every hole that has had its day, today's too, the latest first: its record, how many have played it, and `name`'s result and place. */
export async function holeRecords(game: GameSlug, name: string | null, now = Date.now()): Promise<HoleRecord[]> {
  const today = holeToday(now)
  const last = Math.min(holeNumber(today), holeCount())
  if (last < 1) return []
  const byDay = new Map<string, HoleEntry[]>()
  for (const row of await resultsBetween(game, ACECHASE_FIRST_DAY, holeDay(last))) {
    const list = byDay.get(row.day)
    if (list) list.push(row)
    else byDay.set(row.day, [row])
  }
  const who = name ? name.trim().slice(0, 12).toUpperCase() : null
  const out: HoleRecord[] = []
  for (let n = last; n >= 1; n--) {
    const day = holeDay(n)
    const board = merge(byDay.get(day) ?? [])
    const mine = who ? board.findIndex((e) => e.name === who) : -1
    out.push({
      n,
      day,
      players: board.length,
      record: board[0] ?? null,
      you: mine >= 0 ? { tries: board[mine]!.tries, place: mine + 1 } : null,
    })
  }
  return out
}

/**
 * An account's result on a hole, if it has one: from the hole's day (with the tag it came in under, which
 * is null if it had none then), or from since.
 */
export async function resultOnHole(
  game: GameSlug,
  accountId: string,
  day: string,
): Promise<{ tries: number; name: string | null; onItsDay: boolean } | null> {
  const [onDay] = await db()
    .select({ tries: dailyHoleResults.tries, name: dailyHoleResults.name })
    .from(dailyHoleResults)
    .where(and(eq(dailyHoleResults.accountId, accountId), eq(dailyHoleResults.day, day)))
  if (onDay) return { ...onDay, onItsDay: true }
  const [later] = await db()
    .select({ tries: holeResults.tries, name: holeResults.name })
    .from(holeResults)
    .where(and(eq(holeResults.accountId, accountId), eq(holeResults.game, game), eq(holeResults.day, day)))
  return later ? { ...later, onItsDay: false } : null
}

/** A result from a hole's day that came in with no tag goes on its board under the one the account has now. */
export async function nameDayResult(accountId: string, day: string, name: string): Promise<void> {
  await db()
    .update(dailyHoleResults)
    .set({ name })
    .where(and(eq(dailyHoleResults.accountId, accountId), eq(dailyHoleResults.day, day), isNull(dailyHoleResults.name)))
}

/** Keep a result on a hole after its day: the account's first there, and its only one. False if it had one already. */
export async function addHoleResult(input: {
  game: GameSlug
  day: string
  accountId: string
  name: string
  tries: number
  pattern: string
  device: DeviceType
  at: number
}): Promise<boolean> {
  const added = await db().insert(holeResults).values(input).onConflictDoNothing().returning({ day: holeResults.day })
  return added.length > 0
}
