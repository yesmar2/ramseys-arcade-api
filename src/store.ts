import { asc, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'
import { announceRewrite, insertWithFeed, MULTI_INSTANCE, onChange, onRewrite } from './feed.js'
import { HALFFULL_FIRST_KEY } from './halffull/launch.js'
import { CENTROID_FIRST_KEY } from './centroid/launch.js'

export const ALLOWED_GAMES = [
  'asteroids',
  'patriot',
  'snake',
  'crosswalk',
  'stacker',
  'centroid',
  'pop',
  'simon',
  'spotter',
  'pellets',
  'findbug',
  'crumbtrail',
  'bop',
  'putt',
  'barrage',
  'frenzy',
  'fireflies',
  'acechase',
  'hotlap',
  'halffull',
  'marblerun',
  'lander',
  'pileup',
  'swoop',
] as const
export type GameSlug = (typeof ALLOWED_GAMES)[number]

/** Legacy API / board keys → current slug. */
const GAME_SLUG_ALIASES: Record<string, string> = {
  'dead-center': 'centroid',
  whack: 'pop',
  'whack-a-mole': 'pop',
  stride: 'crosswalk',
}

export function canonicalizeGameSlug(game: string): string {
  return GAME_SLUG_ALIASES[game] ?? game
}

/** Former slugs that now map to this canonical game (for reading old DB rows). */
export function legacyGameSlugs(canonical: GameSlug): string[] {
  return Object.entries(GAME_SLUG_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias)
}

export const PERIODS = ['daily', 'weekly', 'monthly', 'all'] as const
export type Period = (typeof PERIODS)[number]

/** Calendar periods evaluated in this timezone. */
export const BOARD_TZ = 'America/New_York'

export type DeviceType = 'phone' | 'tablet' | 'desktop'

export type LeaderboardEntry = {
  id: string
  name: string
  score: number
  at: number
  device: DeviceType
  /** On a daily's board for the week or the month, where the score is day points (dayPointsBoard): the days they came from. */
  days?: number
  /** The season skin the run was played in (skins.ts), when it was. */
  skin?: string
}

export function isDeviceType(value: unknown): value is DeviceType {
  return value === 'phone' || value === 'tablet' || value === 'desktop'
}

type Store = Record<GameSlug, LeaderboardEntry[]>

/*
 * The board that counts: making the top 100 is what earns a celebration and
 * a place on the default page. It is not a storage limit — every score is
 * kept, and the deep tail is browsable a page at a time.
 */
const BOARD_CUT = 100

/** Default page of a board, for callers that ask for no depth in particular. */
const BOARD_PAGE = 100

function emptyStore(): Store {
  return {
    stacker: [],
    patriot: [],
    snake: [],
    pop: [],
    centroid: [],
    asteroids: [],
    simon: [],
    crosswalk: [],
    spotter: [],
    pellets: [],
    findbug: [],
    crumbtrail: [],
    bop: [],
    putt: [],
    barrage: [],
    frenzy: [],
    fireflies: [],
    pileup: [],
    acechase: [],
    hotlap: [],
    halffull: [],
    marblerun: [],
    lander: [],
    swoop: [],
  }
}

function rowToEntry(row: {
  id: string
  name: string
  score: number
  at: number
  device: string
  skin?: string | null
}): LeaderboardEntry {
  return {
    id: row.id,
    name: row.name,
    score: row.score,
    at: row.at,
    device: isDeviceType(row.device) ? row.device : 'desktop',
    ...(row.skin ? { skin: row.skin } : {}),
  }
}

export async function loadStore(): Promise<Store> {
  const rows = await db().select().from(leaderboardScores)
  const store = emptyStore()
  for (const row of rows) {
    const game = resolveGameSlug(row.game)
    if (!game) continue
    store[game].push(rowToEntry(row))
  }
  return store
}

export async function replaceAllBoards(next: Store) {
  invalidateHistoryCache()
  const store = {
    stacker: Array.isArray(next.stacker) ? next.stacker : [],
    patriot: Array.isArray(next.patriot) ? next.patriot : [],
    snake: Array.isArray(next.snake) ? next.snake : [],
    pop: Array.isArray(next.pop) ? next.pop : [],
    centroid: Array.isArray(next.centroid) ? next.centroid : [],
    asteroids: Array.isArray(next.asteroids) ? next.asteroids : [],
    simon: Array.isArray(next.simon) ? next.simon : [],
    crosswalk: Array.isArray(next.crosswalk) ? next.crosswalk : [],
    spotter: Array.isArray(next.spotter) ? next.spotter : [],
    pellets: Array.isArray(next.pellets) ? next.pellets : [],
    findbug: Array.isArray(next.findbug) ? next.findbug : [],
    crumbtrail: Array.isArray(next.crumbtrail) ? next.crumbtrail : [],
    bop: Array.isArray(next.bop) ? next.bop : [],
    putt: Array.isArray(next.putt) ? next.putt : [],
    barrage: Array.isArray(next.barrage) ? next.barrage : [],
    frenzy: Array.isArray(next.frenzy) ? next.frenzy : [],
    fireflies: Array.isArray(next.fireflies) ? next.fireflies : [],
    pileup: Array.isArray(next.pileup) ? next.pileup : [],
    acechase: Array.isArray(next.acechase) ? next.acechase : [],
    hotlap: Array.isArray(next.hotlap) ? next.hotlap : [],
    halffull: Array.isArray(next.halffull) ? next.halffull : [],
    marblerun: Array.isArray(next.marblerun) ? next.marblerun : [],
    lander: Array.isArray(next.lander) ? next.lander : [],
    swoop: Array.isArray(next.swoop) ? next.swoop : [],
  }
  await db().transaction(async (tx) => {
    await tx.delete(leaderboardScores)
    const values = ALLOWED_GAMES.flatMap((game) =>
      store[game].map((e) => ({
        id: e.id,
        game,
        name: e.name,
        score: e.score,
        at: e.at,
        device: e.device,
        skin: e.skin ?? null,
      })),
    )
    if (values.length) {
      // Insert in chunks to stay under parameter limits
      const chunk = 200
      for (let i = 0; i < values.length; i += chunk) {
        await tx.insert(leaderboardScores).values(values.slice(i, i + chunk))
      }
    }
  })
  await announceRewrite(['scores', 'site-records'])
}

export async function replaceGameBoard(game: GameSlug, entries: LeaderboardEntry[]) {
  invalidateHistoryCache()
  const list = Array.isArray(entries) ? entries : []
  await db().transaction(async (tx) => {
    await tx.delete(leaderboardScores).where(eq(leaderboardScores.game, game))
    if (list.length) {
      await tx.insert(leaderboardScores).values(
        list.map((e) => ({
          id: e.id,
          game,
          name: e.name,
          score: e.score,
          at: e.at,
          device: e.device,
          skin: e.skin ?? null,
        })),
      )
    }
  })
  await announceRewrite(['scores', 'site-records'])
}

/** Board order: the higher score first, and of two equal ones, the earlier. */
function boardOrder(a: LeaderboardEntry, b: LeaderboardEntry) {
  return b.score - a.score || a.at - b.at
}

function sortByScore(entries: LeaderboardEntry[]) {
  return [...entries].sort(boardOrder)
}

function topBoard(entries: LeaderboardEntry[], limit = BOARD_PAGE) {
  return sortByScore(entries).slice(0, limit)
}

type Ymd = { y: number; m: number; d: number; weekday: string }

/*
 * Calendar maths in the board's time zone is the hot loop of every board:
 * each period filter asks what day a score landed on, for every score. A
 * fresh Intl formatter per call cost more than the query did, so there is
 * one formatter per zone, and each answer is kept per quarter hour: every
 * zone's offset, and so its midnight, falls on a quarter hour, so every
 * moment in one has the same date. Kept per timestamp instead, the answers
 * outgrew the cache at a few hundred thousand scores, and a week's standings
 * cost a formatter call per score, a second and a half a request.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()
const ymdCache = new Map<number, Ymd>()
const YMD_CACHE_MAX = 50_000
const QUARTER_HOUR_MS = 15 * 60_000

function formatterFor(timeZone: string) {
  let fmt = formatters.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
    formatters.set(timeZone, fmt)
  }
  return fmt
}

function ymdInTz(ms: number, timeZone = BOARD_TZ): Ymd {
  const quarter = Math.floor(ms / QUARTER_HOUR_MS)
  if (timeZone === BOARD_TZ) {
    const hit = ymdCache.get(quarter)
    if (hit) return hit
  }
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const out = {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    weekday: get('weekday'),
  }
  if (timeZone === BOARD_TZ) {
    if (ymdCache.size >= YMD_CACHE_MAX) ymdCache.clear()
    ymdCache.set(quarter, out)
  }
  return out
}

function dateKey(y: number, m: number, d: number) {
  return y * 10_000 + m * 100 + d
}

function keyOf(ms: number) {
  const { y, m, d } = ymdInTz(ms)
  return dateKey(y, m, d)
}

/** Calendar day key (YYYYMMDD) in BOARD_TZ. */
export function boardDateKey(ms: number) {
  return keyOf(ms)
}

/** Previous calendar day key in BOARD_TZ (UTC date math on Y-M-D parts). */
export function previousBoardDateKey(key: number) {
  const y = Math.floor(key / 10_000)
  const m = Math.floor((key % 10_000) / 100)
  const d = key % 100
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** Monday-start week key (YYYYMMDD of that Monday) in BOARD_TZ. */
export function weekStartKey(ms: number) {
  const { y, m, d, weekday } = ymdInTz(ms)
  const sunFirst: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const daysSinceMonday = ((sunFirst[weekday] ?? 1) + 6) % 7
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - daysSinceMonday)
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

export function isAllowedGame(game: string): game is GameSlug {
  return (ALLOWED_GAMES as readonly string[]).includes(canonicalizeGameSlug(game))
}

/** Resolve a request game id (including legacy aliases) to a store key. */
export function resolveGameSlug(game: string): GameSlug | null {
  const canonical = canonicalizeGameSlug(game)
  return (ALLOWED_GAMES as readonly string[]).includes(canonical)
    ? (canonical as GameSlug)
    : null
}

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value)
}

export type NameScope = ReadonlySet<string> | null | undefined

function filterByNames<T extends { name: string }>(entries: T[], scope?: NameScope): T[] {
  if (!scope) return entries
  return entries.filter((e) => scope.has(e.name))
}

/**
 * Does one timestamp fall inside a period?
 *
 * The same day-key maths the boards filter by, exposed for callers that hold
 * rows of their own — a week has to mean the same week everywhere.
 */
export function inPeriod(at: number, period: Period, now = Date.now()): boolean {
  if (period === 'all') return true
  if (period === 'daily') return keyOf(at) === keyOf(now)
  if (period === 'monthly') {
    const here = ymdInTz(now)
    const there = ymdInTz(at)
    return there.y === here.y && there.m === here.m
  }
  const start = weekStartKey(now)
  const key = keyOf(at)
  return key >= start && key <= keyOf(now)
}

/*
 * The first moment of a board day. Every zone's offset is a whole number of
 * quarter hours, so its midnight falls on a quarter hour, and within fifteen
 * hours of midnight UTC on the same date: a binary search over those quarter
 * hours finds it, each step a cached day lookup.
 */
const dayStarts = new Map<number, number>()

export function dayStartMs(key: number): number {
  const hit = dayStarts.get(key)
  if (hit !== undefined) return hit
  const midnightUtc = Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100)
  let lo = Math.floor((midnightUtc - 15 * 3600_000) / QUARTER_HOUR_MS)
  let hi = Math.ceil((midnightUtc + 15 * 3600_000) / QUARTER_HOUR_MS)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (keyOf(mid * QUARTER_HOUR_MS) < key) lo = mid + 1
    else hi = mid
  }
  if (dayStarts.size >= 1000) dayStarts.clear()
  dayStarts.set(key, lo * QUARTER_HOUR_MS)
  return lo * QUARTER_HOUR_MS
}

/** When the boards' day that `ms` falls in began. */
export function boardDayStart(ms: number): number {
  return dayStartMs(keyOf(ms))
}

/** A period's span as timestamps, from its first moment up to (not including) the first after it. */
function periodSpan(period: Exclude<Period, 'all'>, now: number): [number, number] {
  const today = keyOf(now)
  const tomorrow = dayStartMs(addDaysToDateKey(today, 1))
  if (period === 'daily') return [dayStartMs(today), tomorrow]
  // Monday through today in BOARD_TZ.
  if (period === 'weekly') return [dayStartMs(weekStartKey(now)), tomorrow]
  const { y, m } = ymdInTz(now)
  return [dayStartMs(dateKey(y, m, 1)), dayStartMs(m === 12 ? dateKey(y + 1, 1, 1) : dateKey(y, m + 1, 1))]
}

/*
 * A period's runs: a comparison of two timestamps per run, where it used to
 * be a day lookup per run. The same days either way: a day's first moment is
 * exactly where its day key begins.
 */
export function filterByPeriod(
  entries: LeaderboardEntry[],
  period: Period,
  now = Date.now(),
): LeaderboardEntry[] {
  if (period === 'all') return entries
  const [from, to] = periodSpan(period, now)
  return entries.filter((e) => e.at >= from && e.at < to)
}

export function monthKey(ms: number) {
  const { y, m } = ymdInTz(ms)
  return y * 100 + m
}

function addDaysToDateKey(key: number, days: number) {
  const y = Math.floor(key / 10_000)
  const m = Math.floor((key % 10_000) / 100)
  const d = key % 100
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

export type ClosedPeriod = 'weekly' | 'monthly'

/**
 * Dailies: games with something new to play each day, the same for everyone (Hot Lap's track of the
 * day, Ace Chase's hole of the day, Find the Bug's five scenes of the day, Half Full's five glasses). One
 * day's scores can't be weighed against another day's, so a daily's board for a day is that day's runs, and its board for
 * the week or the month is its days' places: each day's board pays its players points by place, as the
 * standings pay a board (placePoints), and the days add up (dayPointsBoard). Coming back every day counts,
 * and a day's win stays in the week's standings. A daily has no board for all time (ALL_TIME_GAMES). The
 * site marks these games `daily` in its data/games.ts, and prints a daily's board for longer than a day in
 * points. Find the Bug's and Half Full's boards take only a day's first run (firstRun.ts).
 */
export const DAILY_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['hotlap', 'acechase', 'findbug', 'halffull', 'centroid', 'marblerun', 'lander', 'swoop'])

/**
 * The first day (YYYYMMDD) each daily's board was a day's: Ace Chase's held rounds of three holes before
 * it was Today's Hole, and Find the Bug's an endless hunt, whose days weren't the same for everyone. Day
 * points count from here.
 */
export const DAILY_SINCE: Partial<Record<GameSlug, number>> = {
  hotlap: 20260926,
  acechase: 20260927,
  findbug: 20260927,
  halffull: HALFFULL_FIRST_KEY,
  // Centroid's daily #1 (centroid/launch.ts): before it, an endless arcade game.
  centroid: CENTROID_FIRST_KEY,
  // Marble Run's course #1 (marblerunPace.ts MARBLERUN_FIRST_DAY).
  marblerun: 20260929,
  // Lander's cave #1 (landerPace.ts LANDER_FIRST_DAY).
  lander: 20260930,
  // Swoop's course #1 (swoopPace.ts SWOOP_FIRST_DAY).
  swoop: 20261006,
}

/**
 * The dailies that are just for fun, since 2026-09-30: Ace Chase, Find the Bug and Half Full. Their answer is
 * the same for everyone and a friend can hand it over (a hole's power and angle, where the day's bugs hide,
 * how far to fill each glass), so they place nobody: no board longer than a day (no day points), nothing in
 * the standings, no record books, no tickets for a day's top three. A player's own result saves as before:
 * it keeps their days in a row on it (and, until 2026-10-05, punched the Dailies), pays its tickets by its
 * score and is what they share, and the day's runs stay here for that (today's board is read, never shown).
 * Hot Lap, Marble Run, Lander and Swoop, where hands decide, are ranked.
 */
export const UNRANKED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['acechase', 'findbug', 'halffull', 'centroid'])

/** Whether a game's results place its players: on its boards, in the standings and in the record books. */
export const isRankedGame = (game: GameSlug) => !UNRANKED_GAMES.has(game)

/**
 * Games the site has retired (the web's hidden flag): Simon became Fireflies, and Spotter never opened.
 * Their scores stay where they are, but no new event picks one (tournaments.ts), an event already running
 * with one keeps it until it ends, and they count toward nobody's standings (RANKED_GAMES).
 */
export const RETIRED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['simon', 'spotter'])

/**
 * Games the site is holding back to release after launch, one at a time (the web's onDeck flag): listed
 * nowhere, though their own pages still play. Like a retired game, no new event picks one, and they count
 * toward nobody's standings. Take a game off this list the day the site releases it.
 */
// Ace Chase is held back (Ramsey, 2026-10-06: "let's hide it for now").
export const ON_DECK_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['acechase'])

/** Whether a visitor can find a game on the site: neither retired nor on deck (the web's isListedGame). */
export const isListedGame = (game: GameSlug) => !RETIRED_GAMES.has(game) && !ON_DECK_GAMES.has(game)

/**
 * The games the standings add up: the ranked games a visitor can find. A place on a board nobody can see
 * lifts no rank (Ramsey, 2026-10-07: "if games aren't visible, they shouldn't be counted towards rank").
 */
export const RANKED_GAMES: readonly GameSlug[] = ALLOWED_GAMES.filter((game) => isRankedGame(game) && isListedGame(game))

/**
 * The games with a board for all time, and so in the all-time standings: the ranked games but the dailies.
 * A daily's days' points added up since it began would mostly count the days played, so whoever came first
 * would stay first (Ramsey's call, 2026-10-05). The dailies count toward the week's and the month's
 * standings, where everyone has the same days.
 */
export const ALL_TIME_GAMES: readonly GameSlug[] = RANKED_GAMES.filter((game) => !DAILY_GAMES.has(game))

/** The games a period's standings add up. */
export function standingsGames(period: Period): readonly GameSlug[] {
  return period === 'all' ? ALL_TIME_GAMES : RANKED_GAMES
}

/**
 * A daily's board for more than a day: one row a player, their day points (each day's board pays by
 * place, placePoints), from the runs of those days in board order. A tie goes to whoever reached the
 * total first: the latest of the days' best runs that make it up.
 */
function dayPointsBoard(game: GameSlug, runs: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const since = DAILY_SINCE[game] ?? 0
  const days = new Map<number, LeaderboardEntry[]>()
  for (const run of runs) {
    const key = keyOf(run.at)
    if (key < since) continue
    const list = days.get(key)
    if (list) list.push(run)
    else days.set(key, [run])
  }
  const totals = new Map<string, LeaderboardEntry & { days: number }>()
  for (const dayRuns of days.values()) {
    // In board order, so each player's first run on a day is their best that day.
    const seen = new Set<string>()
    const best: LeaderboardEntry[] = []
    for (const run of dayRuns) {
      if (seen.has(run.name)) continue
      seen.add(run.name)
      best.push(run)
    }
    best.forEach((run, i) => {
      const points = placePoints(i + 1, best.length)
      const had = totals.get(run.name)
      if (!had) {
        // In the skin of their latest day's best run, as the board shows a run's (the site's SkinMark).
        totals.set(run.name, { id: `days:${game}:${run.name}`, name: run.name, score: points, at: run.at, device: run.device, ...(run.skin ? { skin: run.skin } : {}), days: 1 })
        return
      }
      had.score += points
      had.days += 1
      if (run.at > had.at) {
        had.at = run.at
        had.device = run.device
        if (run.skin) had.skin = run.skin
        else delete had.skin
      }
    })
  }
  return [...totals.values()].sort(boardOrder)
}

/**
 * A game's runs in a closed period, in board order: a daily's are its days' points (see DAILY_GAMES), and one
 * just for fun has none (UNRANKED_GAMES).
 */
function closedRuns(game: GameSlug, history: LeaderboardEntry[], period: ClosedPeriod, periodKey: number) {
  const runs = filterByClosedPeriod(history, period, periodKey)
  if (!DAILY_GAMES.has(game)) return runs
  return isRankedGame(game) ? dayPointsBoard(game, runs) : []
}

export function filterByClosedPeriod(
  entries: LeaderboardEntry[],
  period: ClosedPeriod,
  periodKey: number,
) {
  if (period === 'weekly') {
    const end = addDaysToDateKey(periodKey, 6)
    return entries.filter((e) => {
      const k = keyOf(e.at)
      return k >= periodKey && k <= end
    })
  }
  const y = Math.floor(periodKey / 100)
  const m = periodKey % 100
  return entries.filter((e) => {
    const p = ymdInTz(e.at)
    return p.y === y && p.m === m
  })
}

/*
 * Score history, read once and kept current.
 *
 * Every board, rank, and summary starts from a game's full history, and the
 * standings need all of them. Each was its own round trip to the database
 * — about a tenth of a second each on Neon — so one rankings page cost a
 * couple of seconds before it drew anything. So the whole table is loaded in
 * one query, in board order, and handed out per game.
 *
 * A saved score is put into its place in that copy as it lands. It used to
 * throw the copy away instead, so every save cost a read of every score ever
 * saved: fine at a few thousand, and at a few hundred thousand the reads
 * queued behind each other until nothing answered. It is read again at once
 * when something rewrites scores wholesale (invalidateHistoryCache).
 *
 * Every ten minutes the copy is checked against the table, in case a script
 * changed it underneath: how many rows, the sum of their scores and the
 * newest, asked of the database in one small query and compared with the
 * same three kept for the copy. Only if they differ is the table read again.
 * It used to be read again whole every ten minutes, every score sent over the
 * wire and every board and standing redrawn, for a table that hadn't changed.
 *
 * With more than one server, each save reaches the other servers' copies
 * through the change feed (feed.ts), and there is no look at the table: the
 * others' saves not yet read from the feed would look like a change every
 * time. A script that rewrites the table says so through the feed instead.
 */
const HISTORY_TTL_MS = 10 * 60_000

/** One reading of the table, numbered so a view knows which reading it was drawn from. */
type HistoryCopy = {
  at: number
  epoch: number
  byGame: Map<string, LeaderboardEntry[]>
  /** What the copy holds, to compare with the table: rows, the sum of their scores, the newest. */
  rows: number
  scoreSum: number
  lastAt: number
}

/** Saves between writing their row and putting it in the copy, and how many have begun: a check can't tell those from a change. */
let scoreWritesInFlight = 0
let scoreWritesBegun = 0
let historyCheck: Promise<void> | null = null
let nextHistoryCheckAt = 0

/** In the background, never in a request's way; again in five seconds if saves kept it from an answer. */
function checkHistorySoon(copy: HistoryCopy) {
  const now = Date.now()
  if (historyCheck || now < nextHistoryCheckAt) return
  nextHistoryCheckAt = now + 5_000
  historyCheck = checkHistory(copy)
    .catch((err: unknown) => console.warn('[history] checking the scores table failed:', err))
    .finally(() => {
      historyCheck = null
    })
}

async function checkHistory(copy: HistoryCopy) {
  if (scoreWritesInFlight > 0) return
  const begun = scoreWritesBegun
  const [table] = await db()
    .select({
      rows: sql<number>`count(*)::float8`,
      scoreSum: sql<number>`coalesce(sum(${leaderboardScores.score}), 0)::float8`,
      lastAt: sql<number>`coalesce(max(${leaderboardScores.at}), 0)::float8`,
    })
    .from(leaderboardScores)
  if (historyCache !== copy || scoreWritesBegun !== begun || scoreWritesInFlight > 0) return
  if (
    table &&
    Number(table.rows) === copy.rows &&
    Number(table.scoreSum) === copy.scoreSum &&
    Number(table.lastAt) === copy.lastAt
  ) {
    copy.at = Date.now()
    return
  }
  console.log('[history] the scores table changed outside this process: reading it again')
  invalidateHistoryCache()
}

let historyCache: HistoryCopy | null = null
let historyLoading: Promise<HistoryCopy> | null = null
let historyEpoch = 0
/** Counts wholesale rewrites: a reading begun before one is handed out but not kept. */
let historyInvalidations = 0
/** Scores saved while a reading was under way: put into the new copy when it lands. */
let savedDuringLoad: { game: string; entry: LeaderboardEntry }[] = []
/** Moves each time a game takes a score in place; a view of that game is redrawn when it does. */
const gameVersions = new Map<string, number>()

export function invalidateHistoryCache() {
  historyCache = null
  historyInvalidations++
}

/*
 * Every tag gets a number once, and every run in the history carries its
 * player (under a symbol: never in a run's JSON), so a board view finds each
 * player's best run with a stamp and a typed array rather than a look-up by
 * name per run. A board is redrawn on every save to its game, and hashing
 * every name on it was most of what a save cost.
 */
type PlayerRef = { pid: number; stamp: number }
const PLAYER = Symbol('player')
type HistoryRun = LeaderboardEntry & { [PLAYER]?: PlayerRef }
const playerRefs = new Map<string, PlayerRef>()
/** Moves once per view drawn: a player whose stamp is this view's has been counted in it. */
let viewStamp = 0

function playerRef(name: string): PlayerRef {
  let ref = playerRefs.get(name)
  if (!ref) {
    ref = { pid: playerRefs.size, stamp: 0 }
    playerRefs.set(name, ref)
  }
  return ref
}

/** A run going into the history, tagged with its player. */
function withPlayer(entry: LeaderboardEntry): LeaderboardEntry {
  ;(entry as HistoryRun)[PLAYER] ??= playerRef(entry.name)
  return entry
}

function refOf(entry: LeaderboardEntry): PlayerRef {
  return (entry as HistoryRun)[PLAYER] ?? playerRef(entry.name)
}

/** Put a score into a list already in board order, after any it ties with exactly. */
function insertInOrder(list: LeaderboardEntry[], entry: LeaderboardEntry) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (boardOrder(list[mid], entry) <= 0) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, entry)
}

/** Where a run sits in a list in board order: a binary search to its place, not a scan for its id. */
function indexOfRun(list: LeaderboardEntry[], entry: LeaderboardEntry): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (boardOrder(list[mid], entry) < 0) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < list.length && boardOrder(list[i], entry) === 0; i++) {
    if (list[i].id === entry.id) return i
  }
  return -1
}

/** A score just written to the table, put into the history in place. */
function rememberScore(game: string, entry: LeaderboardEntry) {
  withPlayer(entry)
  if (historyLoading) savedDuringLoad.push({ game, entry })
  if (historyCache) {
    const list = historyCache.byGame.get(game) ?? []
    insertInOrder(list, entry)
    historyCache.byGame.set(game, list)
    historyCache.rows++
    historyCache.scoreSum += entry.score
    if (entry.at > historyCache.lastAt) historyCache.lastAt = entry.at
  }
  gameVersions.set(game, (gameVersions.get(game) ?? 0) + 1)
}

/** Another server's save: into the copy in its place, unless the copy was read with it already there. */
onChange<{ game: string; entry: LeaderboardEntry }>('score', ({ game, entry }) => {
  const run: LeaderboardEntry = {
    id: String(entry.id),
    name: String(entry.name),
    score: Number(entry.score),
    at: Number(entry.at),
    device: isDeviceType(entry.device) ? entry.device : 'desktop',
    ...(typeof entry.skin === 'string' && entry.skin ? { skin: entry.skin } : {}),
  }
  const list = historyCache?.byGame.get(game)
  if (list && indexOfRun(list, run) !== -1) return
  rememberScore(game, run)
  noteSave(run.name)
})

onRewrite('scores', () => invalidateHistoryCache())

async function loadCopy(): Promise<HistoryCopy> {
  if (historyCache) {
    if (!MULTI_INSTANCE && Date.now() - historyCache.at >= HISTORY_TTL_MS) checkHistorySoon(historyCache)
    return historyCache
  }
  if (historyLoading) return historyLoading
  savedDuringLoad = []
  const invalidationsAtStart = historyInvalidations
  historyLoading = (async () => {
    const rows = await db()
      .select()
      .from(leaderboardScores)
      .orderBy(desc(leaderboardScores.score), asc(leaderboardScores.at))
    const byGame = new Map<string, LeaderboardEntry[]>()
    let count = 0
    let scoreSum = 0
    let lastAt = 0
    const counted = (entry: LeaderboardEntry) => {
      count++
      scoreSum += entry.score
      if (entry.at > lastAt) lastAt = entry.at
    }
    for (const row of rows) {
      const list = byGame.get(row.game) ?? []
      const entry = withPlayer(rowToEntry(row))
      list.push(entry)
      counted(entry)
      byGame.set(row.game, list)
    }
    // A score saved while the table was being read may or may not be in what came back.
    for (const { game, entry } of savedDuringLoad) {
      const list = byGame.get(game) ?? []
      if (!list.some((e) => e.id === entry.id)) {
        insertInOrder(list, entry)
        counted(entry)
      }
      byGame.set(game, list)
    }
    savedDuringLoad = []
    const copy: HistoryCopy = {
      at: Date.now(),
      epoch: ++historyEpoch,
      byGame,
      rows: count,
      scoreSum,
      lastAt,
    }
    // Rewritten wholesale while this was reading: good enough to answer with, not to keep.
    if (invalidationsAtStart === historyInvalidations) historyCache = copy
    return copy
  })().finally(() => {
    historyLoading = null
  })
  return historyLoading
}

async function loadHistory(): Promise<Map<string, LeaderboardEntry[]>> {
  return (await loadCopy()).byGame
}

/**
 * Every score on every board, per game in board order: the same copy the
 * boards are drawn from, for folds over all of it (the site's records) that
 * would otherwise read the whole table again. Read it; never change it.
 */
export async function allScores(): Promise<ReadonlyMap<string, readonly LeaderboardEntry[]>> {
  return loadHistory()
}

/**
 * One player's runs on one game, newest first: read from the history, where
 * each run knows its player, rather than from the table on every save.
 */
export async function playerRuns(game: GameSlug, name: string): Promise<{ score: number; at: number }[]> {
  const list = (await loadHistory()).get(game) ?? []
  const ref = playerRefs.get(name)
  if (!ref) return []
  const runs: { score: number; at: number }[] = []
  for (const e of list) {
    if ((e as HistoryRun)[PLAYER] === ref) runs.push({ score: e.score, at: e.at })
  }
  return runs.sort((a, b) => b.at - a.at)
}

/**
 * `name`'s best run on a game, any day, or null if they've never played it: the first of theirs in its history,
 * which is in board order. What a daily has in place of a board for all time (ALL_TIME_GAMES).
 */
export async function bestRunEver(game: GameSlug, name: string): Promise<number | null> {
  const list = (await loadHistory()).get(game) ?? []
  const ref = playerRefs.get(name.trim().slice(0, 12).toUpperCase())
  if (!ref) return null
  for (const e of list) {
    if ((e as HistoryRun)[PLAYER] === ref) return e.score
  }
  return null
}

/** The ranked dailies `name` has a run on, any day: what the all-time standings, which leave them out, can't say. */
export async function dailiesPlayed(name: string): Promise<GameSlug[]> {
  const played: GameSlug[] = []
  for (const game of RANKED_GAMES) {
    if (DAILY_GAMES.has(game) && (await bestRunEver(game, name)) != null) played.push(game)
  }
  return played
}

async function historyFor(game: GameSlug): Promise<LeaderboardEntry[]> {
  const byGame = await loadHistory()
  return byGame.get(game) ?? []
}

/*
 * A game's board for one period, drawn once and kept until the game takes a
 * score, the history is read again, or the period moves on. The history is in
 * board order, so a period's board is a filter of it, never a sort; with it
 * comes where each player's best run sits, which is what a player's rank and
 * the standings are read from. Before this, every board, rank and summary
 * filtered and sorted every score of every game it touched, per request.
 */
type PoolView = {
  epoch: number
  version: number
  window: string
  entries: LeaderboardEntry[]
  /** Each player's best run, by their number (playerRef): its index in entries, plus one; 0 if not on it. */
  bestIndex: Int32Array
  /** The place of the player whose best run is at each index, or 0: kept flat, it costs four bytes a run. */
  placeAt: Int32Array
  /** How many players are on it: the field a place is out of. */
  players: number
}

const poolViews = new Map<string, PoolView>()

/** What a period's board covers from now: a new day moves the daily and weekly ones, a new month the monthly. */
export function periodWindow(period: Period, now: number): string {
  if (period === 'all') return 'all'
  if (period === 'monthly') return String(monthKey(now))
  return String(keyOf(now))
}

async function poolView(game: GameSlug, period: Period, now = Date.now()): Promise<PoolView> {
  const copy = await loadCopy()
  const history = copy.byGame.get(game) ?? []
  const epoch = copy.epoch
  const version = gameVersions.get(game) ?? 0
  const window = periodWindow(period, now)
  const key = `${game}:${period}`
  const hit = poolViews.get(key)
  if (hit && hit.epoch === epoch && hit.version === version && hit.window === window) return hit
  // A daily's board for a day is the day's runs; for the week or the month, its days' points (see DAILY_GAMES),
  // and none for all time (ALL_TIME_GAMES) or for one just for fun (UNRANKED_GAMES).
  const runs = period === 'all' ? history : filterByPeriod(history, period, now)
  const longer = DAILY_GAMES.has(game) && period !== 'daily'
  const entries = longer
    ? isRankedGame(game) && period !== 'all'
      ? dayPointsBoard(game, runs)
      : []
    : period === 'all'
      ? history.slice()
      : runs
  // Board order, so a player's first run here is their best.
  const stamp = ++viewStamp
  let bestIndex = new Int32Array(playerRefs.size)
  const placeAt = new Int32Array(entries.length)
  let players = 0
  for (let i = 0; i < entries.length; i++) {
    const ref = refOf(entries[i])
    if (ref.stamp === stamp) continue
    ref.stamp = stamp
    if (ref.pid >= bestIndex.length) {
      const grown = new Int32Array(playerRefs.size)
      grown.set(bestIndex)
      bestIndex = grown
    }
    bestIndex[ref.pid] = i + 1
    placeAt[i] = ++players
  }
  const view: PoolView = { epoch, version, window, entries, bestIndex, placeAt, players }
  poolViews.set(key, view)
  return view
}

/** Where a player's best run sits in a view, or -1. */
function bestIndexOf(view: PoolView, ref: PlayerRef | undefined): number {
  if (!ref || ref.pid >= view.bestIndex.length) return -1
  return view.bestIndex[ref.pid] - 1
}

/** The same, by tag. */
function bestIndexOfName(view: PoolView, name: string): number {
  return bestIndexOf(view, playerRefs.get(name))
}

/** `name`'s best run of a daily's day, with its place that day and the day points it earned (points are null before DAILY_SINCE). */
export type DailyDayYou = LeaderboardEntry & { place: number | null; points: number | null }

/**
 * A daily game's days, newest first: how many runs and players each had, its best run (a tie going to
 * whoever got there first), and `name`'s best that day if they played, with the place it earned and the
 * points that place paid toward the week (placePoints). What the site's archive of past days shows, and
 * the day-by-day workings of a daily's week. `keep` says which runs are a day's result at all.
 *
 * The place and points are counted as dayPointsBoard counts them, from DAILY_SINCE, over every run of
 * the day, so a player's days' points over a week add up to their score on its board. A day before
 * DAILY_SINCE (Ace Chase's holes #1 and #2) has a place among its kept runs and no points.
 */
export async function dailyDays(
  game: GameSlug,
  name?: string | null,
  keep: (score: number) => boolean = () => true,
): Promise<{ day: number; runs: number; players: number; top: LeaderboardEntry; you: DailyDayYou | null }[]> {
  const copy = await loadCopy()
  const who = name ? name.trim().slice(0, 12).toUpperCase() : null
  const since = DAILY_SINCE[game] ?? 0
  const days = new Map<
    number,
    {
      runs: number
      names: Set<string>
      top: LeaderboardEntry | null
      you: LeaderboardEntry | null
      /** The day's players as the day points count them, and where `who` came among them. */
      field: Set<string>
      place: number
    }
  >()
  // Board order, best first: a day's first run met is its best, and a player's first their best.
  for (const entry of copy.byGame.get(game) ?? []) {
    const key = keyOf(entry.at)
    let day = days.get(key)
    if (!day) {
      day = { runs: 0, names: new Set(), top: null, you: null, field: new Set(), place: 0 }
      days.set(key, day)
    }
    if (key >= since && !day.field.has(entry.name)) {
      day.field.add(entry.name)
      if (entry.name === who) day.place = day.field.size
    }
    if (!keep(entry.score)) continue
    // A day before day points still has places, among its kept runs (Ace Chase's holes #1 and #2), but pays none.
    if (key < since && !day.field.has(entry.name)) {
      day.field.add(entry.name)
      if (entry.name === who) day.place = day.field.size
    }
    day.runs++
    day.names.add(entry.name)
    day.top ??= entry
    if (who && !day.you && entry.name === who) day.you = entry
  }
  const out: { day: number; runs: number; players: number; top: LeaderboardEntry; you: DailyDayYou | null }[] = []
  for (const [day, d] of days) {
    if (!d.top) continue
    const place = d.place || null
    out.push({
      day,
      runs: d.runs,
      players: d.names.size,
      top: d.top,
      you: d.you ? { ...d.you, place, points: place && day >= since ? placePoints(place, d.field.size) : null } : null,
    })
  }
  return out.sort((a, b) => b.day - a.day)
}

/** Every run's score on a game, best first, all time: what its ticket ladder is drawn from (ticketLadders.ts). */
export async function runScores(game: GameSlug): Promise<number[]> {
  const copy = await loadCopy()
  return (copy.byGame.get(game) ?? []).map((entry) => entry.score)
}

type DayPlayer = { name: string; score: number; at: number; device: DeviceType; skin?: string }

/*
 * Each day's players on a game, drawn from the history once and kept until the game takes a score or the
 * history is read again. A Hot Lap track's board reads a day for each time it was driven, and the list of
 * tracks reads every day there has been: each of those was a walk over every run of the game.
 */
const dayIndexes = new Map<string, { epoch: number; version: number; byDay: Map<number, DayPlayer[]> }>()

async function dayIndex(game: GameSlug): Promise<Map<number, DayPlayer[]>> {
  const copy = await loadCopy()
  const version = gameVersions.get(game) ?? 0
  const hit = dayIndexes.get(game)
  if (hit && hit.epoch === copy.epoch && hit.version === version) return hit.byDay
  const byDay = new Map<number, DayPlayer[]>()
  const seen = new Map<number, Set<string>>()
  // Board order: best first, and the earlier of two the same.
  for (const entry of copy.byGame.get(game) ?? []) {
    const key = keyOf(entry.at)
    let names = seen.get(key)
    if (!names) {
      names = new Set()
      seen.set(key, names)
      byDay.set(key, [])
    }
    if (names.has(entry.name)) continue
    names.add(entry.name)
    byDay.get(key)!.push({ name: entry.name, score: entry.score, at: entry.at, device: entry.device, ...(entry.skin ? { skin: entry.skin } : {}) })
  }
  dayIndexes.set(game, { epoch: copy.epoch, version, byDay })
  return byDay
}

/**
 * A day's players on a game, best first: each tag's best run that day, a tie
 * going to whoever got there first. What a daily's top three are paid by
 * (tickets.ts), once the day is over, and a Hot Lap track's own board begins
 * with (trackLaps.ts): each best with when it was set and on what.
 */
export async function dayPlayers(game: GameSlug, dayKey: number): Promise<DayPlayer[]> {
  // Copies: the kept day is shared by every caller.
  return ((await dayIndex(game)).get(dayKey) ?? []).map((p) => ({ ...p }))
}

/** A player's row on a daily's day board: their best run that day and the place it earned. */
export type DayBoardRow = DayPlayer & { place: number }

/**
 * A page of a daily's board for one day (YYYYMMDD), as it closed, or stands so far for today: one row a
 * player, their best run that day, a tie going to whoever got there first. That's the order the day's
 * points were paid in (dayPointsBoard) and the places the days' list gives (dailyDays), whose `keep` this
 * takes: before the game's days counted (DAILY_SINCE) only kept runs are the day's field, as there. In a
 * group (`scope`) the places are among its members. `name`'s row that day, if they played, is `you`.
 */
export async function dayBoardPage(
  game: GameSlug,
  dayKey: number,
  opts: { offset?: number; limit?: number; scope?: NameScope; name?: string | null; keep?: (score: number) => boolean } = {},
): Promise<{ entries: DayBoardRow[]; total: number; you: DayBoardRow | null }> {
  let field = (await dayIndex(game)).get(dayKey) ?? []
  // After the index's one run a player, not before it as dailyDays does: the same field, since a kept run
  // always outscores one that isn't (dayResultKeep), so a player's best is kept whenever any of theirs is.
  const keep = opts.keep
  if (keep && dayKey < (DAILY_SINCE[game] ?? 0)) field = field.filter((p) => keep(p.score))
  field = filterByNames(field, opts.scope)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? BOARD_PAGE))
  const row = (i: number): DayBoardRow => ({ ...field[i], place: i + 1 })
  const entries: DayBoardRow[] = []
  for (let i = offset; i < Math.min(field.length, offset + limit); i++) entries.push(row(i))
  const who = opts.name ? opts.name.trim().slice(0, 12).toUpperCase() : null
  const mine = who ? field.findIndex((p) => p.name === who) : -1
  return { entries, total: field.length, you: mine >= 0 ? row(mine) : null }
}

export async function getClosedBoard(
  game: GameSlug,
  period: ClosedPeriod,
  periodKey: number,
): Promise<LeaderboardEntry[]> {
  return topBoard(closedRuns(game, await historyFor(game), period, periodKey))
}

export async function getBoard(
  game: GameSlug,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
  limit = BOARD_PAGE,
): Promise<LeaderboardEntry[]> {
  return filterByNames((await poolView(game, period, now)).entries, scope).slice(0, limit)
}

/**
 * One window onto a board, and how deep it goes.
 *
 * The field is whole — every score ever posted — so a board is browsable all
 * the way down rather than stopping at the hundredth row. `total` is what
 * lets a caller know there is more below, and what a rank is out of.
 */
export async function getBoardPage(
  game: GameSlug,
  period: Period = 'all',
  opts: { offset?: number; limit?: number; now?: number; scope?: NameScope } = {},
): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  const now = opts.now ?? Date.now()
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? BOARD_PAGE))
  const pool = filterByNames((await poolView(game, period, now)).entries, opts.scope)
  return { entries: pool.slice(offset, offset + limit), total: pool.length }
}

/* ---------- a board as players ---------- */

/** One player on a board: their best run, its place among the players, and how many runs they have on it. */
export type PlayerRow = LeaderboardEntry & { place: number; runs: number }

/** A board's players, best first, with each one's run count: worked out once a view (or once a group's ask). */
type PlayerField = { bests: LeaderboardEntry[]; runs: Map<string, number>; at: Map<string, number> }

const playerFields = new WeakMap<PoolView, PlayerField>()

function fieldOf(entries: LeaderboardEntry[]): PlayerField {
  const bests: LeaderboardEntry[] = []
  const runs = new Map<string, number>()
  const at = new Map<string, number>()
  // Board order: a player's first run met is their best.
  for (const e of entries) {
    const n = runs.get(e.name)
    if (n === undefined) {
      at.set(e.name, bests.length)
      bests.push(e)
      runs.set(e.name, 1)
    } else runs.set(e.name, n + 1)
  }
  return { bests, runs, at }
}

/** How many of a board's players have a best better than `score` (higher is better on every board). */
function playersAbove(bests: LeaderboardEntry[], score: number): number {
  let lo = 0
  let hi = bests.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bests[mid]!.score > score) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The places a board is split at for "Beat X to reach the top …": the top 10, 100, 1,000 and half. */
function bandPlaces(field: number): number[] {
  const out = [10, 100, 1000].filter((p) => p < field)
  const half = Math.ceil(field / 2)
  if (field >= 20 && !out.includes(half)) out.push(half)
  return out.sort((a, b) => a - b)
}

/**
 * A board as players, a page at a time, with places worked out here so a page can show any part of a
 * board of any size: the site used to read every run and count places itself, and stopped at 2,000 runs.
 * With `name`: their row, the few players either side of them, the place a run just better than the
 * player above takes, the next band up (the top 10, 100, 1,000 or half) and the score that gets into it,
 * and their own runs on the board (for the chart of them). With `find`: up to ten players whose tag
 * holds it. With `marks`: the rows at those places (a game's page reads 1st, 10th, the middle and its share
 * lines), each with the place a run just better than it takes. With `would`: the place a run of that
 * score would take now, behind everyone at or above it. In a group (`scope`) all of it is among its members.
 */
export async function playerBoard(
  game: GameSlug,
  period: Period,
  opts: {
    offset?: number
    limit?: number
    now?: number
    scope?: NameScope
    name?: string | null
    find?: string | null
    around?: number
    marks?: number[]
    would?: number | null
  } = {},
): Promise<{
  entries: PlayerRow[]
  total: number
  runs: number
  you: PlayerRow | null
  around: PlayerRow[]
  nextPlace: number | null
  band: { place: number; half: boolean; score: number } | null
  yourRuns: LeaderboardEntry[]
  found: PlayerRow[]
  marked: (PlayerRow & { beatPlace: number })[]
  wouldPlace: number | null
}> {
  const view = await poolView(game, period, opts.now ?? Date.now())
  let field: PlayerField
  let runCount: number
  if (opts.scope) {
    const pool = filterByNames(view.entries, opts.scope)
    field = fieldOf(pool)
    runCount = pool.length
  } else {
    field = playerFields.get(view) ?? fieldOf(view.entries)
    playerFields.set(view, field)
    runCount = view.entries.length
  }
  const { bests } = field
  const row = (i: number): PlayerRow => {
    const e = bests[i]!
    return { ...e, place: i + 1, runs: field.runs.get(e.name) ?? 1 }
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? BOARD_PAGE))
  const entries: PlayerRow[] = []
  for (let i = offset; i < Math.min(bests.length, offset + limit); i++) entries.push(row(i))

  const who = opts.name ? opts.name.trim().slice(0, 12).toUpperCase() : ''
  const mine = who ? field.at.get(who) : undefined
  let you: PlayerRow | null = null
  let around: PlayerRow[] = []
  let nextPlace: number | null = null
  let band: { place: number; half: boolean; score: number } | null = null
  let yourRuns: LeaderboardEntry[] = []
  if (mine !== undefined) {
    you = row(mine)
    const span = Math.max(0, Math.min(10, Math.floor(opts.around ?? 2)))
    for (let i = Math.max(0, mine - span); i <= Math.min(bests.length - 1, mine + span); i++) around.push(row(i))
    // A run just better than the player above: past everyone at or below their score.
    nextPlace = mine > 0 ? playersAbove(bests, bests[mine - 1]!.score) + 1 : 1
    const places = bandPlaces(bests.length).filter((p) => p < mine + 1)
    const into = places[places.length - 1]
    // The top half, when that's the band, is named as one rather than by its place.
    const half = (p: number) => p === Math.ceil(bests.length / 2) && p !== 10 && p !== 100 && p !== 1000
    if (into) band = { place: into, half: half(into), score: bests[into - 1]!.score }
    const source = opts.scope ? filterByNames(view.entries, opts.scope) : view.entries
    for (const e of source) {
      if (e.name !== who) continue
      yourRuns.push(e)
      if (yourRuns.length >= 200) break
    }
  }

  const q = opts.find ? opts.find.trim().toUpperCase() : ''
  const found: PlayerRow[] = []
  if (q) {
    for (let i = 0; i < bests.length && found.length < 10; i++) if (bests[i]!.name.includes(q)) found.push(row(i))
  }
  const marked: (PlayerRow & { beatPlace: number })[] = []
  for (const place of new Set(opts.marks ?? [])) {
    if (!Number.isInteger(place) || place < 1 || place > bests.length) continue
    marked.push({ ...row(place - 1), beatPlace: playersAbove(bests, bests[place - 1]!.score) + 1 })
  }
  // Behind everyone at or above it (scores are whole numbers): a tie goes to whoever got there first, and a
  // new run is the latest.
  const wouldPlace = opts.would != null && Number.isFinite(opts.would) ? playersAbove(bests, Math.ceil(opts.would) - 1) + 1 : null
  return { entries, total: bests.length, runs: runCount, you, around, nextPlace, band, yourRuns, found, marked, wouldPlace }
}

export type PeriodBoardSummary = Record<Period, LeaderboardEntry[]>

/** Top N entries per game for one period — one pass over local store. */
export async function boardsSummaryForPeriod(
  period: Period,
  limit = 3,
  now = Date.now(),
  scope?: NameScope,
): Promise<Record<GameSlug, LeaderboardEntry[]>> {
  const capped = Math.min(10, Math.max(1, Math.floor(limit)) || 3)
  const out = {} as Record<GameSlug, LeaderboardEntry[]>
  for (const game of ALLOWED_GAMES) {
    // A daily just for fun shows nobody's name on a board (UNRANKED_GAMES).
    out[game] = isRankedGame(game) ? (await getBoard(game, period, now, scope)).slice(0, capped) : []
  }
  return out
}

/** Top N entries per game and period — one pass over local store. */
export async function boardsSummary(
  limit = 3,
  now = Date.now(),
): Promise<Record<GameSlug, PeriodBoardSummary>> {
  const capped = Math.min(10, Math.max(1, Math.floor(limit)) || 3)
  const out = {} as Record<GameSlug, PeriodBoardSummary>
  for (const game of ALLOWED_GAMES) {
    const byPeriod = {} as PeriodBoardSummary
    for (const period of PERIODS) {
      byPeriod[period] = isRankedGame(game) ? (await getBoard(game, period, now)).slice(0, capped) : []
    }
    out[game] = byPeriod
  }
  return out
}

export type YouEntry = LeaderboardEntry & { rank: number; place: number }

export async function bestForName(
  game: GameSlug,
  name: string,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<YouEntry | null> {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return null
  const view = await poolView(game, period, now)
  if (!scope) {
    const at = bestIndexOfName(view, cleaned)
    return at < 0 ? null : { ...view.entries[at], rank: at + 1, place: view.placeAt[at] }
  }
  const pool = filterByNames(view.entries, scope)
  const at = pool.findIndex((e) => e.name === cleaned)
  if (at < 0) return null
  const ahead = new Set<string>()
  for (let i = 0; i < at; i++) ahead.add(pool[i].name)
  return { ...pool[at], rank: at + 1, place: ahead.size + 1 }
}

export async function bestsForName(
  name: string,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<Partial<Record<GameSlug, number>>> {
  const out: Partial<Record<GameSlug, number>> = {}
  for (const game of ALLOWED_GAMES) {
    const row = await bestForName(game, name, period, now, scope)
    if (row) out[game] = row.score
  }
  return out
}

/**
 * Ties in the standings go to the name first in the alphabet. One collator,
 * made once, sorts the same as localeCompare with no locale given, which built
 * its rules afresh each call: most of a standings sort's time at twenty
 * thousand players.
 */
const nameOrder = new Intl.Collator()

/** Placement points from a full-field place: 1st ≈ 100, last ≈ 1, scales with N. */
export function placePoints(place: number, fieldSize: number): number {
  if (place < 1 || fieldSize < 1 || place > fieldSize) return 0
  return Math.max(1, Math.round((100 * (fieldSize - place + 1)) / fieldSize))
}

/**
 * How many of a player's games the standings add up: the ten that pay them most (Ramsey's call,
 * 2026-10-07). Every game added up, the standings mostly counted how many games someone played, and
 * each game the arcade added made that worse: halfway down every board outranked 1st on a few. Past
 * ten, a game counts only by beating one of the ten, so a new game is a chance at a better place,
 * never a chore. The site's lib/profileMath.ts COUNTED_GAMES says the same.
 */
export const STANDINGS_BEST = 10

/** A player's standings points from what each of their games pays (0 for none): the best STANDINGS_BEST added up. */
export function bestGamesTotal(points: ArrayLike<number>): number {
  let games = 0
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    if (p <= 0) continue
    games++
    sum += p
  }
  if (games <= STANDINGS_BEST) return sum
  const most = Array.from(points)
    .filter((p) => p > 0)
    .sort((a, b) => b - a)
  sum = 0
  for (let i = 0; i < STANDINGS_BEST; i++) sum += most[i]!
  return sum
}

export type GlobalGamePlace = {
  place: number
  points: number
  /** How many players were on that board for the period: the field the place is out of. */
  total: number
}

export type GlobalRankEntry = {
  name: string
  rank: number
  score: number
  games: number
  byGame: Partial<Record<GameSlug, GlobalGamePlace>>
}

/** Unique players in score order for global rank — full field, not board-capped. */
function placementsFromPool(pool: LeaderboardEntry[]): { name: string; place: number }[] {
  const seen = new Set<string>()
  const bests: string[] = []
  for (const entry of pool) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    bests.push(entry.name)
  }
  return bests.map((name, i) => ({ name, place: i + 1 }))
}

async function periodPlacements(
  game: GameSlug,
  period: Period,
  now = Date.now(),
  scope?: NameScope,
): Promise<{ name: string; place: number }[]> {
  const view = await poolView(game, period, now)
  if (scope) return placementsFromPool(filterByNames(view.entries, scope))
  const out: { name: string; place: number }[] = []
  for (let i = 0; i < view.entries.length; i++) {
    const place = view.placeAt[i]
    if (place) out.push({ name: view.entries[i].name, place })
  }
  return out
}

async function closedPeriodPlacements(
  game: GameSlug,
  period: ClosedPeriod,
  periodKey: number,
): Promise<{ name: string; place: number }[]> {
  // The history is in board order, so its scores from any period already are.
  return placementsFromPool(closedRuns(game, await historyFor(game), period, periodKey))
}

async function aggregateGlobalRanks(
  placementsForGame: (game: GameSlug) => Promise<{ name: string; place: number }[]>,
  games: readonly GameSlug[] = RANKED_GAMES,
): Promise<GlobalRankEntry[]> {
  const byName = new Map<
    string,
    { points: number[]; games: number; byGame: Partial<Record<GameSlug, GlobalGamePlace>> }
  >()

  for (const game of games) {
    const placements = await placementsForGame(game)
    const fieldSize = placements.length
    for (const { name, place } of placements) {
      const points = placePoints(place, fieldSize)
      if (points <= 0) continue
      const row = byName.get(name) ?? { points: [], games: 0, byGame: {} }
      row.points.push(points)
      row.games += 1
      row.byGame[game] = { place, points, total: fieldSize }
      byName.set(name, row)
    }
  }

  const ranked = [...byName.entries()]
    .map(([name, row]) => ({ name, score: bestGamesTotal(row.points), games: row.games, byGame: row.byGame }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.games !== a.games) return b.games - a.games
      return nameOrder.compare(a.name, b.name)
    })

  return ranked.map((row, i) => ({
    name: row.name,
    rank: i + 1,
    score: row.score,
    games: row.games,
    byGame: row.byGame,
  }))
}

/*
 * The standings for one period, kept and brought up to date a game at a time.
 *
 * Adding up every player's points from every game on every request was the
 * slowest thing the API did: at twenty thousand players, a quarter of a
 * second of work per request, which a few dozen people browsing turned into a
 * queue that never cleared. Now each game's places are counted in once, and
 * when a game takes a score only that game's places are taken out and counted
 * in again, then the players are put in order: at most half a second behind
 * for anyone browsing, and never behind for the player who just saved (see
 * STANDINGS_SETTLE_MS).
 *
 * Each player's total is kept, and what each game pays them, a byte a game:
 * the total is their best ten (STANDINGS_BEST), so a game's points can't just
 * be added on, since which ten count can change with them. Where they placed
 * on each game is read off that game's board when a line is asked for, a
 * handful at a time; kept for everyone, it was most of the API's memory.
 */
/** A player's line in the standings: what each game pays them, their total, and where it puts them. */
type StandingRow = {
  name: string
  score: number
  games: number
  pos: number
  /** What each of the period's games pays them, in standingsGames order; 0 on a game they're not on. */
  pays: Uint8Array
}

type StandingsView = {
  epoch: number
  window: string
  /** When the boards it was counted from were read. */
  asOf: number
  /** How many games the period's standings count: how long each row's pays is. */
  slots: number
  /** The board each game's places were counted from. */
  counted: Map<GameSlug, PoolView>
  /** Each player's line, by name: the same rows as in order. */
  tallies: Map<string, StandingRow>
  /** Players in standings order; each row's pos is its index here. */
  order: StandingRow[]
  /** The tallies changed in a way order can't be patched for: sort it whole. */
  unsorted: boolean
}

const standingsViews = new Map<Period, StandingsView>()

/** Standings order: more points first, then more games, then the name first in the alphabet. */
function standingOrder(a: StandingRow, b: StandingRow) {
  if (b.score !== a.score) return b.score - a.score
  if (b.games !== a.games) return b.games - a.games
  return nameOrder.compare(a.name, b.name)
}

/** A player new to the standings, on no game yet: settleRows gives them their total. */
function newRow(view: StandingsView, name: string): StandingRow {
  const row: StandingRow = { name, score: 0, games: 0, pos: -1, pays: new Uint8Array(view.slots) }
  view.tallies.set(name, row)
  return row
}

/**
 * Count one game's places into the tallies, or (sign -1) take them back out. `slot` is the game's
 * place in standingsGames; the players it touches go in `moved`, for settleRows.
 */
function countPlaces(view: StandingsView, pool: PoolView, slot: number, sign: 1 | -1, moved: Set<StandingRow>) {
  for (let i = 0; i < pool.entries.length; i++) {
    const place = pool.placeAt[i]
    if (!place) continue
    const name = pool.entries[i].name
    const points = placePoints(place, pool.players)
    if (points <= 0) continue
    let row = view.tallies.get(name)
    if (sign > 0) {
      row ??= newRow(view, name)
      row.pays[slot] = points
    } else if (row) {
      row.pays[slot] = 0
    } else {
      continue
    }
    moved.add(row)
  }
  view.unsorted = true
}

/**
 * The totals of the players whose games' points moved, from what each game pays them now: their best
 * ten added up (bestGamesTotal). A player no game pays any more leaves the standings.
 */
function settleRows(view: StandingsView, moved: Set<StandingRow>) {
  for (const row of moved) {
    let games = 0
    for (let i = 0; i < row.pays.length; i++) if (row.pays[i]! > 0) games++
    row.games = games
    row.score = bestGamesTotal(row.pays)
    if (games > 0) continue
    view.tallies.delete(row.name)
    view.unsorted = true
  }
}

/*
 * A save moves a few players' points, not everyone's: a place is worth one of
 * a hundred steps of points, so the players a new run pushes down a place
 * mostly keep what they had. So when a game's board changes, its places are
 * counted again against the board they were last counted from, and only the
 * players whose points changed are touched. Counting every player out and in
 * again, then sorting twenty thousand, was most of what the API did under a
 * crowd, in stretches of half a second and more.
 *
 * False when the board lost a player since, which only happens when the
 * history is read again (and then the standings start over anyway): the
 * difference can't be counted then, so the caller counts the game out and in.
 */
function recountPlaces(view: StandingsView, had: PoolView, pool: PoolView, slot: number, moved: Set<StandingRow>): boolean {
  const changes: { name: string; points: number }[] = []
  let kept = 0
  for (let i = 0; i < pool.entries.length; i++) {
    const place = pool.placeAt[i]
    if (!place) continue
    const entry = pool.entries[i]
    const points = placePoints(place, pool.players)
    const hadAt = bestIndexOf(had, refOf(entry))
    let was = 0
    if (hadAt >= 0) {
      kept++
      was = placePoints(had.placeAt[hadAt], had.players)
    }
    if (points !== was) changes.push({ name: entry.name, points })
  }
  if (kept !== had.players) return false
  for (const { name, points } of changes) {
    const row = view.tallies.get(name) ?? newRow(view, name)
    row.pays[slot] = points
    // Marked to come out of order and go back in where its new total puts it.
    row.pos = -1
    moved.add(row)
  }
  return true
}

function sortStandings(view: StandingsView) {
  const order = [...view.tallies.values()]
  order.sort(standingOrder)
  for (let i = 0; i < order.length; i++) order[i].pos = i
  view.order = order
  view.unsorted = false
}

/**
 * Put the players whose totals moved back in order: everyone else keeps
 * their order, so each moved player's place is a binary search, not a sort.
 */
function reorderStandings(view: StandingsView, moved: Set<StandingRow>) {
  if (moved.size > view.order.length / 8) {
    sortStandings(view)
    return
  }
  const stay = view.order.filter((row) => row.pos !== -1)
  const coming = [...moved].sort(standingOrder)
  const order: StandingRow[] = new Array(stay.length + coming.length)
  let k = 0
  let from = 0
  for (const row of coming) {
    let lo = from
    let hi = stay.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (standingOrder(stay[mid], row) < 0) lo = mid + 1
      else hi = mid
    }
    while (from < lo) order[k++] = stay[from++]
    order[k++] = row
  }
  while (from < stay.length) order[k++] = stay[from++]
  for (let i = 0; i < order.length; i++) order[i].pos = i
  view.order = order
}

/** The line at one place in the standings, with where the player placed on each game. */
function standingAt(view: StandingsView, i: number): GlobalRankEntry {
  const row = view.order[i]
  const byGame: Partial<Record<GameSlug, GlobalGamePlace>> = {}
  const ref = playerRefs.get(row.name)
  for (const game of RANKED_GAMES) {
    const pool = view.counted.get(game)
    if (!pool) continue
    const at = bestIndexOf(pool, ref)
    if (at < 0) continue
    const place = pool.placeAt[at]
    byGame[game] = { place, points: placePoints(place, pool.players), total: pool.players }
  }
  return { name: row.name, rank: i + 1, score: row.score, games: row.games, byGame }
}

/*
 * Counting a game in again and putting twenty thousand players in order takes
 * a few tens of milliseconds, and every save calls for it. So the standings
 * stand for half a second after each count: saves inside it share the next
 * one. The player who just saved is never shown the count from before their
 * save; they wait for the next, at most that half second.
 */
const STANDINGS_SETTLE_MS = 500
/** When each player last saved a score, for "is this count from after my save?" */
const savedAt = new Map<string, number>()
const standingsRefresh = new Map<Period, Promise<StandingsView>>()

function noteSave(name: string) {
  if (savedAt.size >= 100_000) savedAt.clear()
  savedAt.set(name, Date.now())
}

async function refreshStandings(period: Period, now: number): Promise<StandingsView> {
  const asOf = Date.now()
  // Every game's board first. Reading one can land a new copy of the history,
  // and places from two copies mustn't be added together, so read again then.
  const games = standingsGames(period)
  let pools: PoolView[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    pools = []
    for (const game of games) pools.push(await poolView(game, period, now))
    if (pools.every((pool) => pool.epoch === pools[0].epoch)) break
  }
  const epoch = pools[0]?.epoch ?? 0
  const window = periodWindow(period, now)
  let view = standingsViews.get(period)
  if (!view || view.epoch !== epoch || view.window !== window) {
    view = { epoch, window, asOf, slots: games.length, counted: new Map(), tallies: new Map(), order: [], unsorted: true }
    standingsViews.set(period, view)
  }
  const moved = new Set<StandingRow>()
  games.forEach((game, slot) => {
    const pool = pools[slot]
    const had = view.counted.get(game)
    if (had === pool) return
    if (!had || !recountPlaces(view, had, pool, slot, moved)) {
      if (had) countPlaces(view, had, slot, -1, moved)
      countPlaces(view, pool, slot, 1, moved)
    }
    view.counted.set(game, pool)
  })
  settleRows(view, moved)
  if (view.unsorted) sortStandings(view)
  else if (moved.size) reorderStandings(view, moved)
  view.asOf = asOf
  return view
}

/** The standings for a period; `forName` asks for a count from after that player's last save. */
async function standingsView(period: Period, now: number, forName?: string): Promise<StandingsView> {
  const mine = forName ? (savedAt.get(forName) ?? 0) : 0
  for (let round = 0; round < 3; round++) {
    const view = standingsViews.get(period)
    const current = view && !view.unsorted && view.window === periodWindow(period, now)
    if (view && current && view.asOf > mine && Date.now() - view.asOf < STANDINGS_SETTLE_MS) return view
    // Just saved: wait out the moment, so saves close together share one count.
    if (view && current && mine >= view.asOf) {
      const wait = STANDINGS_SETTLE_MS - (Date.now() - view.asOf)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
    let pending = standingsRefresh.get(period)
    if (!pending) {
      pending = refreshStandings(period, now).finally(() => standingsRefresh.delete(period))
      standingsRefresh.set(period, pending)
    }
    const fresh = await pending
    if (fresh.asOf > mine) return fresh
  }
  return refreshStandings(period, now)
}

export async function globalRanks(
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<GlobalRankEntry[]> {
  if (scope) return aggregateGlobalRanks((game) => periodPlacements(game, period, now, scope), standingsGames(period))
  const view = await standingsView(period, now)
  return view.order.map((_, i) => standingAt(view, i))
}

/** One page of the standings, and how many players they run to. */
export async function globalRanksPage(
  period: Period,
  offset: number,
  limit: number,
  now = Date.now(),
  scope?: NameScope,
): Promise<{ total: number; entries: GlobalRankEntry[] }> {
  if (scope) {
    const all = await globalRanks(period, now, scope)
    return { total: all.length, entries: all.slice(offset, offset + limit) }
  }
  const view = await standingsView(period, now)
  const total = view.order.length
  const entries: GlobalRankEntry[] = []
  for (let i = Math.max(0, offset); i < Math.min(total, offset + limit); i++) entries.push(standingAt(view, i))
  return { total, entries }
}

/** Up to ten players on the Standings whose tag holds `find`, best first, each with its place. */
export async function findInStandings(
  period: Period,
  find: string,
  now = Date.now(),
  scope?: NameScope,
): Promise<GlobalRankEntry[]> {
  const q = find.trim().slice(0, 12).toUpperCase()
  if (!q) return []
  if (scope) return (await globalRanks(period, now, scope)).filter((e) => e.name.includes(q)).slice(0, 10)
  const view = await standingsView(period, now)
  const found: GlobalRankEntry[] = []
  for (let i = 0; i < view.order.length && found.length < 10; i++) if (view.order[i]!.name.includes(q)) found.push(standingAt(view, i))
  return found
}

/** Global ranks for a completed weekly or monthly period. */
export async function globalRanksForClosedPeriod(
  period: ClosedPeriod,
  periodKey: number,
): Promise<GlobalRankEntry[]> {
  return aggregateGlobalRanks(async (game) => {
    // Seconds of work at a few hundred thousand scores, if rarely asked for:
    // a game at a time, letting requests through in between.
    await new Promise((resolve) => setImmediate(resolve))
    return closedPeriodPlacements(game, period, periodKey)
  })
}

/**
 * The standings over a stretch that isn't a week or a month: a season's (seasons.ts). Each game's runs in
 * it make its board, as a closed week's do (a daily's, its day points), and the places add up as they do
 * for any period. Seconds of work on a big history, so its caller keeps the answer a while.
 */
export async function globalRanksForWindow(startMs: number, endMs: number): Promise<GlobalRankEntry[]> {
  return aggregateGlobalRanks(async (game) => {
    await new Promise((resolve) => setImmediate(resolve))
    // The history is in board order, so its runs in any stretch already are.
    const runs = (await historyFor(game)).filter((e) => e.at >= startMs && e.at < endMs)
    const pool = !DAILY_GAMES.has(game) ? runs : isRankedGame(game) ? dayPointsBoard(game, runs) : []
    return placementsFromPool(pool)
  })
}

export async function rankForName(
  name: string,
  neighborRadius = 2,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<{
  rank: number | null
  score: number
  totalPlayers: number
  byGame: Partial<Record<GameSlug, GlobalGamePlace>>
  nearby: GlobalRankEntry[]
}> {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  const nobody = (totalPlayers: number) => ({ rank: null, score: 0, totalPlayers, byGame: {}, nearby: [] })
  if (scope) {
    const all = await globalRanks(period, now, scope)
    const me = cleaned ? all.find((row) => row.name === cleaned) : undefined
    if (!me) return nobody(all.length)
    const idx = me.rank - 1
    return {
      rank: me.rank,
      score: me.score,
      totalPlayers: all.length,
      byGame: me.byGame,
      nearby: all.slice(Math.max(0, idx - neighborRadius), Math.min(all.length, idx + neighborRadius + 1)),
    }
  }
  const view = await standingsView(period, now, cleaned || undefined)
  const total = view.order.length
  const idx = cleaned ? view.tallies.get(cleaned)?.pos : undefined
  if (idx == null) return nobody(total)
  const me = standingAt(view, idx)
  const nearby: GlobalRankEntry[] = []
  for (let i = Math.max(0, idx - neighborRadius); i < Math.min(total, idx + neighborRadius + 1); i++) {
    nearby.push(i === idx ? me : standingAt(view, i))
  }
  return { rank: me.rank, score: me.score, totalPlayers: total, byGame: me.byGame, nearby }
}

export async function qualifies(
  game: GameSlug,
  score: number,
  period: Period = 'daily',
  now = Date.now(),
): Promise<boolean> {
  if (score <= 0) return false
  // A daily just for fun has no board to make (UNRANKED_GAMES).
  if (!isRankedGame(game)) return false
  // A run goes on a daily's board for its day; the longer boards are day points (see DAILY_GAMES).
  if (DAILY_GAMES.has(game) && period !== 'daily') return false
  const board = await getBoard(game, period, now)
  if (board.length < BOARD_CUT) return true
  return score > board[board.length - 1].score
}

/** True if the score makes any period board. */
export async function qualifiesAny(
  game: GameSlug,
  score: number,
  now = Date.now(),
): Promise<boolean> {
  for (const period of PERIODS) {
    if (await qualifies(game, score, period, now)) return true
  }
  return false
}

export async function rankForScore(
  game: GameSlug,
  score: number,
  period: Period = 'daily',
  now = Date.now(),
): Promise<number | null> {
  if (score <= 0) return null
  if (!isRankedGame(game)) return null
  if (DAILY_GAMES.has(game) && period !== 'daily') return null
  // The board is in score order, highest first: count the scores above this one by halving.
  const { entries } = await poolView(game, period, now)
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].score > score) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

export async function ranksForScore(
  game: GameSlug,
  score: number,
  now = Date.now(),
): Promise<Partial<Record<Period, number>>> {
  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const rank = await rankForScore(game, score, period, now)
    if (rank != null) ranks[period] = rank
  }
  return ranks
}

/**
 * What the server observed about the run behind a score.
 *
 * Every field is optional and none of it is shown on a board: it exists so a
 * suspect score can be looked into after the fact, which is the only tool that
 * still works once a determined cheat gets past the plausibility check.
 */
export type ScoreAudit = {
  runId?: string | null
  durationMs?: number | null
  ipHash?: string | null
  userAgent?: string | null
  /** The season skin it was played in, already checked as owned (skins.ts runSkin). */
  skin?: string | null
}

export async function addScore(
  game: GameSlug,
  name: string,
  score: number,
  device: DeviceType = 'desktop',
  audit: ScoreAudit = {},
): Promise<{
  board: LeaderboardEntry[]
  entry: LeaderboardEntry
  rank: number | null
  ranks: Partial<Record<Period, number>>
  previousBestRanks: Partial<Record<Period, number>>
  bestRanks: Partial<Record<Period, number>>
}> {
  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  const now = Date.now()
  const previousBestRanks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const prior = await bestForName(game, cleaned, period, now)
    if (prior) previousBestRanks[period] = prior.rank
  }

  const entry: LeaderboardEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score,
    at: now,
    device: isDeviceType(device) ? device : 'desktop',
    ...(audit.skin ? { skin: audit.skin } : {}),
  }

  /*
   * Every score is kept. This used to prune to the top 500 per game and drop
   * anything older than 100 days, which made sense when the store was a JSON
   * file rewritten in full on every write — it is a table now, and a rank
   * only means something if the field behind it is real. Once written, it
   * goes into the history in place (rememberScore): no reading it all back.
   */
  // Written and in the copy, or neither, before a check of the table may count it (checkHistory).
  scoreWritesInFlight++
  scoreWritesBegun++
  try {
    // With more than one server, the row and the news of it for the others land together.
    await insertWithFeed(
      db().insert(leaderboardScores).values({
        id: entry.id,
        game,
        name: entry.name,
        score: entry.score,
        at: entry.at,
        device: entry.device,
        runId: audit.runId ?? null,
        durationMs: audit.durationMs ?? null,
        ipHash: audit.ipHash ?? null,
        userAgent: audit.userAgent?.slice(0, 256) ?? null,
        skin: entry.skin ?? null,
      }),
      'score',
      { game, entry },
    )
    rememberScore(game, entry)
  } finally {
    scoreWritesInFlight--
  }
  noteSave(cleaned)

  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const { entries } = await poolView(game, period, now)
    const index = indexOfRun(entries, entry)
    if (index !== -1) ranks[period] = index + 1
  }

  const bestRanks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const best = await bestForName(game, cleaned, period, now)
    if (best) bestRanks[period] = best.rank
  }

  const rank = ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null
  return {
    board: await getBoard(game, 'daily'),
    entry,
    rank,
    ranks,
    previousBestRanks,
    bestRanks,
  }
}

/** Rename a player across all game boards (history rows keep the new tag). */
export async function renamePlayerAcrossLeaderboards(
  fromRaw: string,
  toRaw: string,
): Promise<{ from: string; to: string; updated: number }> {
  const from = fromRaw.trim().slice(0, 12).toUpperCase()
  const to = toRaw.trim().slice(0, 12).toUpperCase()
  if (!from || !to || from === to) return { from, to, updated: 0 }

  invalidateHistoryCache()
  const updated = await db()
    .update(leaderboardScores)
    .set({ name: to })
    .where(eq(leaderboardScores.name, from))
    .returning({ id: leaderboardScores.id })
  if (updated.length) await announceRewrite(['scores'])
  return { from, to, updated: updated.length }
}
