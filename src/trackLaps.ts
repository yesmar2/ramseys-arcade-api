import crypto from 'node:crypto'
import { asc, desc, eq, and } from 'drizzle-orm'
import { db } from './db/client.js'
import { trackLaps } from './db/schema.js'
import { HOTLAP_FIRST_DAY, HOTLAP_PACE_MS } from './hotlapPace.js'
import { boardDateKey, dayPlayers, dayStartMs, type DeviceType, type GameSlug } from './store.js'

/*
 * Track records. Every Hot Lap track keeps a board of its own for good. On its day a track is the Daily,
 * and its laps are the day's board (store.ts), which closes at midnight with the day's places, points and
 * tickets. After that the track stays open: a lap on it comes here, and the track's board is its day's
 * laps and every lap since, each driver's best. Nothing here feeds the day's board, the standings, events,
 * tickets or the record books, and nothing that reads those reads this.
 *
 * Tracks are the plan's (the site's dailyPlan.ts; the API has its blue cars in hotlapPace.ts): track n is
 * day n's, and past the plan's end the days go round again, so day d drives track ((d − 1) % tracks) + 1.
 */

/** The games whose tracks keep boards of their own. */
export const TRACK_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['hotlap'])

/** How many tracks the plan has. */
export function trackCount(): number {
  return HOTLAP_PACE_MS.length
}

const dayUtc = (key: number) => Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100)
const FIRST = (() => {
  const [y, m, d] = HOTLAP_FIRST_DAY.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
})()

/** A board day's number: 1 on the first day. */
export function dayNumberOf(key: number): number {
  return Math.round((dayUtc(key) - FIRST) / 86_400_000) + 1
}

/** The board day (YYYYMMDD) of a day's number. */
export function dayKeyOf(n: number): number {
  const at = new Date(FIRST + (n - 1) * 86_400_000)
  return at.getUTCFullYear() * 10_000 + (at.getUTCMonth() + 1) * 100 + at.getUTCDate()
}

/** The track a day drives. */
export function trackOfDay(n: number): number {
  return ((n - 1) % trackCount()) + 1
}

/** A track's first day as YYYY-MM-DD: the day it was the Daily. */
export function trackDayIso(n: number): string {
  const key = dayKeyOf(n)
  return `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`
}

/**
 * Where a track stands today: 'past' once its day has come and gone (a lap on it comes here), 'today'
 * while it's the Daily (a lap goes on the day's board), 'ahead' before its day (a test drive, kept
 * nowhere), or 'none' for a track the plan hasn't got.
 */
export function trackState(n: number, now = Date.now()): 'past' | 'today' | 'ahead' | 'none' {
  if (!Number.isInteger(n) || n < 1 || n > trackCount()) return 'none'
  const today = dayNumberOf(boardDateKey(now))
  if (today >= 1 && trackOfDay(today) === n) return 'today'
  return n <= today ? 'past' : 'ahead'
}

/** The fastest a lap on a track can be believed, in ms: well under anyone's so far (the best is about 85% of the blue car's). */
export function fastestBelievable(n: number): number {
  return Math.round((HOTLAP_PACE_MS[n - 1] ?? 40_000) * 0.7)
}

/** A driver's best lap on a track: their tag, its score, and when (a day's lap, at its day's start). */
export type TrackEntry = { name: string; score: number; at: number }

/** Each driver's best lap on a track, best first, a tie going to the earlier: its days' laps and every lap since. */
function merge(dayBests: TrackEntry[], laps: TrackEntry[]): TrackEntry[] {
  const best = new Map<string, TrackEntry>()
  for (const lap of [...dayBests, ...laps]) {
    const had = best.get(lap.name)
    if (!had || lap.score > had.score || (lap.score === had.score && lap.at < had.at)) best.set(lap.name, lap)
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.at - b.at)
}

/** A track's days' laps, each driver's best: its first day's, and any later day that drove it again. */
async function dayLaps(game: GameSlug, n: number, today: number): Promise<TrackEntry[]> {
  const out: TrackEntry[] = []
  for (let d = n; d <= today; d += trackCount()) {
    const key = dayKeyOf(d)
    const at = dayStartMs(key)
    for (const p of await dayPlayers(game, key)) out.push({ name: p.name, score: p.score, at })
  }
  return out
}

/** A track's board: each driver's best lap on it, best first. */
export async function trackBoard(game: GameSlug, n: number, now = Date.now()): Promise<TrackEntry[]> {
  const today = dayNumberOf(boardDateKey(now))
  const rows = await db()
    .select({ name: trackLaps.name, score: trackLaps.score, at: trackLaps.at })
    .from(trackLaps)
    .where(and(eq(trackLaps.game, game), eq(trackLaps.track, n)))
    .orderBy(desc(trackLaps.score), asc(trackLaps.at))
  return merge(await dayLaps(game, n, today), rows)
}

export type TrackRecord = {
  track: number
  /** Its day, YYYY-MM-DD. */
  day: string
  /** How many have driven it. */
  drivers: number
  record: TrackEntry | null
  /** `name`'s best on it and their place, if they've driven it. */
  you: { score: number; place: number } | null
}

/** Every track that has had its day, the latest first: its record, how many have driven it, and `name`'s best and place. */
export async function trackRecords(game: GameSlug, name: string | null, now = Date.now()): Promise<TrackRecord[]> {
  const today = dayNumberOf(boardDateKey(now))
  const last = Math.min(today, trackCount())
  if (last < 1) return []
  const rows = await db()
    .select({ track: trackLaps.track, name: trackLaps.name, score: trackLaps.score, at: trackLaps.at })
    .from(trackLaps)
    .where(eq(trackLaps.game, game))
    .orderBy(desc(trackLaps.score), asc(trackLaps.at))
  const later = new Map<number, TrackEntry[]>()
  for (const r of rows) {
    const list = later.get(r.track)
    if (list) list.push(r)
    else later.set(r.track, [r])
  }
  const who = name ? name.trim().slice(0, 12).toUpperCase() : null
  const out: TrackRecord[] = []
  for (let n = last; n >= 1; n--) {
    const board = merge(await dayLaps(game, n, today), later.get(n) ?? [])
    const mine = who ? board.findIndex((e) => e.name === who) : -1
    out.push({
      track: n,
      day: trackDayIso(n),
      drivers: board.length,
      record: board[0] ?? null,
      you: mine >= 0 ? { score: board[mine]!.score, place: mine + 1 } : null,
    })
  }
  return out
}

/** Keep a lap on a track after its day. */
export async function addTrackLap(input: {
  game: GameSlug
  track: number
  accountId: string
  name: string
  score: number
  device: DeviceType
  runId: string | null
  durationMs: number | null
}): Promise<void> {
  await db()
    .insert(trackLaps)
    .values({ id: crypto.randomBytes(12).toString('base64url'), ...input, at: Date.now() })
}
