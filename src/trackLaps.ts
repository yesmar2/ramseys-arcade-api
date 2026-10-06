import crypto from 'node:crypto'
import { asc, desc, eq, and } from 'drizzle-orm'
import { db } from './db/client.js'
import { trackLaps } from './db/schema.js'
import { HOTLAP_FIRST_DAY, HOTLAP_PACE_MS } from './hotlapPace.js'
import { LANDER_FIRST_DAY, LANDER_PACE_MS } from './landerPace.js'
import { MARBLERUN_FIRST_DAY, MARBLERUN_PACE_MS } from './marblerunPace.js'
import { SWOOP_FIRST_DAY, SWOOP_PACE_MS } from './swoopPace.js'
import { boardDateKey, dayPlayers, isDeviceType, type DeviceType, type GameSlug } from './store.js'

/*
 * Course records. Every course of a ranked daily keeps a board of its own for good: Hot Lap's tracks, Marble
 * Run's courses, Lander's caves and Swoop's hills (the table and the routes still say "track", from when Hot
 * Lap's were the only ones). On its day a course is the Daily, and its runs are the day's board (store.ts),
 * which closes at midnight with the day's places, points and tickets. After that the course stays open: a run
 * on it comes here, and the course's board, its All time board, is its day's runs and every run since, each
 * player's best.
 * Nothing here feeds the day's board, the standings, events or the day's tickets, and nothing that reads those
 * reads this. A Hot Lap track's record is in Hot Lap's record book too (courseRecords.ts), and taking any
 * course's record after its day pays a few tickets, once (trackLapsRoutes.ts).
 *
 * Hot Lap's tracks are the plan's (the site's dailyPlan.ts; the API has its blue cars in hotlapPace.ts): track
 * n is day n's, and past the plan's end the days go round again, so day d drives track ((d − 1) % tracks) + 1.
 * Marble Run's courses, Lander's caves and Swoop's hills are numbered by their day, 1 on the first, and never
 * come round again: the plan's layouts may, but each day's is a course of its own (the site's daily.ts
 * courseNumber, caveNumber and hillsNumber).
 */

/** How a game numbers its courses, and the fastest run on one it believes, as a share of the blue run's time. */
type CoursePlan = { firstDay: string; pace: readonly number[]; repeats: boolean; floor: number }

const PLANS: Partial<Record<GameSlug, CoursePlan>> = {
  // The best lap so far is about 85% of the blue car's.
  hotlap: { firstDay: HOTLAP_FIRST_DAY, pace: HOTLAP_PACE_MS, repeats: true, floor: 0.7 },
  // As a day's board believes them (routes.ts).
  marblerun: { firstDay: MARBLERUN_FIRST_DAY, pace: MARBLERUN_PACE_MS, repeats: false, floor: 0.6 },
  lander: { firstDay: LANDER_FIRST_DAY, pace: LANDER_PACE_MS, repeats: false, floor: 0.45 },
  swoop: { firstDay: SWOOP_FIRST_DAY, pace: SWOOP_PACE_MS, repeats: false, floor: 0.33 },
}

/** The games whose courses keep boards of their own. */
export const TRACK_GAMES: ReadonlySet<GameSlug> = new Set(Object.keys(PLANS) as GameSlug[])

/** Far past any plan: a number no Marble Run course or Lander cave will have. */
const MOST_DAYS = 100_000

const planOf = (game: GameSlug): CoursePlan => PLANS[game] ?? PLANS.hotlap!

/** How many tracks Hot Lap's plan has. */
export function trackCount(): number {
  return HOTLAP_PACE_MS.length
}

const dayUtc = (key: number) => Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100)
const firstUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/** A board day's number in a game: 1 on its first day. Hot Lap's unless said. */
export function dayNumberOf(key: number, game: GameSlug = 'hotlap'): number {
  return Math.round((dayUtc(key) - firstUtc(planOf(game).firstDay)) / 86_400_000) + 1
}

/** The board day (YYYYMMDD) of a day's number in a game. Hot Lap's unless said. */
export function dayKeyOf(n: number, game: GameSlug = 'hotlap'): number {
  const at = new Date(firstUtc(planOf(game).firstDay) + (n - 1) * 86_400_000)
  return at.getUTCFullYear() * 10_000 + (at.getUTCMonth() + 1) * 100 + at.getUTCDate()
}

/** The track a Hot Lap day drives. */
export function trackOfDay(n: number): number {
  return ((n - 1) % trackCount()) + 1
}

/** The course a game's day plays: Hot Lap's tracks go round; any other game's course is its day's number. */
function courseOfDay(game: GameSlug, n: number): number {
  return planOf(game).repeats ? trackOfDay(n) : n
}

/** How many courses a game has: Hot Lap's plan's tracks, or a number no other game's days will reach. */
function courseCount(game: GameSlug): number {
  return planOf(game).repeats ? trackCount() : MOST_DAYS
}

/** A course's first day as YYYY-MM-DD: the day it was the Daily. Hot Lap's unless said. */
export function trackDayIso(n: number, game: GameSlug = 'hotlap'): string {
  const key = dayKeyOf(n, game)
  return `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`
}

/**
 * Where a course stands today: 'past' once its day has come and gone (a run on it comes here), 'today'
 * while it's the Daily (a run goes on the day's board), 'ahead' before its day (a test run, kept
 * nowhere), or 'none' for a course the game hasn't got. Hot Lap's unless said.
 */
export function trackState(n: number, now = Date.now(), game: GameSlug = 'hotlap'): 'past' | 'today' | 'ahead' | 'none' {
  if (!Number.isInteger(n) || n < 1 || n > courseCount(game)) return 'none'
  const today = dayNumberOf(boardDateKey(now), game)
  if (today >= 1 && courseOfDay(game, today) === n) return 'today'
  return n <= today ? 'past' : 'ahead'
}

/** The fastest run on a course that can be believed, in ms: well under its blue run's time. Hot Lap's unless said. */
export function fastestBelievable(n: number, game: GameSlug = 'hotlap'): number {
  const plan = planOf(game)
  const pace = plan.pace.length ? plan.pace[(n - 1) % plan.pace.length] : undefined
  return Math.round((pace ?? 40_000) * plan.floor)
}

/** A driver's best lap on a track: their tag, its score, when it was driven and on what. */
export type TrackEntry = { name: string; score: number; at: number; device: DeviceType; skin?: string }

/** Each driver's best lap on a track, best first, a tie going to the earlier: its days' laps and every lap since. */
function merge(dayBests: TrackEntry[], laps: TrackEntry[]): TrackEntry[] {
  const best = new Map<string, TrackEntry>()
  for (const lap of [...dayBests, ...laps]) {
    const had = best.get(lap.name)
    if (!had || lap.score > had.score || (lap.score === had.score && lap.at < had.at)) best.set(lap.name, lap)
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.at - b.at)
}

/** A course's days' runs, each player's best: its first day's, and any later day that played it again (Hot Lap's tracks go round). */
async function dayLaps(game: GameSlug, n: number, today: number): Promise<TrackEntry[]> {
  const out: TrackEntry[] = []
  const step = planOf(game).repeats ? trackCount() : Infinity
  for (let d = n; d <= today; d += step) {
    for (const p of await dayPlayers(game, dayKeyOf(d, game))) out.push({ name: p.name, score: p.score, at: p.at, device: p.device, ...(p.skin ? { skin: p.skin } : {}) })
  }
  return out
}

const lapDevice = (device: string): DeviceType => (isDeviceType(device) ? device : 'desktop')

/** A course's All time board: each player's best run on it, best first. */
export async function trackBoard(game: GameSlug, n: number, now = Date.now()): Promise<TrackEntry[]> {
  const today = dayNumberOf(boardDateKey(now), game)
  const rows = await db()
    .select({ name: trackLaps.name, score: trackLaps.score, at: trackLaps.at, device: trackLaps.device, skin: trackLaps.skin })
    .from(trackLaps)
    .where(and(eq(trackLaps.game, game), eq(trackLaps.track, n)))
    .orderBy(desc(trackLaps.score), asc(trackLaps.at))
  return merge(
    await dayLaps(game, n, today),
    rows.map(({ skin, ...r }) => ({ ...r, device: lapDevice(r.device), ...(skin ? { skin } : {}) })),
  )
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
  const today = dayNumberOf(boardDateKey(now), game)
  const last = Math.min(today, courseCount(game))
  if (last < 1) return []
  const rows = await db()
    .select({ track: trackLaps.track, name: trackLaps.name, score: trackLaps.score, at: trackLaps.at, device: trackLaps.device })
    .from(trackLaps)
    .where(eq(trackLaps.game, game))
    .orderBy(desc(trackLaps.score), asc(trackLaps.at))
  const later = new Map<number, TrackEntry[]>()
  for (const r of rows) {
    const lap = { name: r.name, score: r.score, at: r.at, device: lapDevice(r.device) }
    const list = later.get(r.track)
    if (list) list.push(lap)
    else later.set(r.track, [lap])
  }
  const who = name ? name.trim().slice(0, 12).toUpperCase() : null
  const out: TrackRecord[] = []
  for (let n = last; n >= 1; n--) {
    const board = merge(await dayLaps(game, n, today), later.get(n) ?? [])
    const mine = who ? board.findIndex((e) => e.name === who) : -1
    out.push({
      track: n,
      day: trackDayIso(n, game),
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
  skin?: string | null
}): Promise<void> {
  await db()
    .insert(trackLaps)
    .values({ id: crypto.randomBytes(12).toString('base64url'), ...input, at: Date.now() })
}
