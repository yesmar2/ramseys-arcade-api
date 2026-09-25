import { asc, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'
import { announceRewrite, insertWithFeed, MULTI_INSTANCE, onChange, onRewrite } from './feed.js'

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
    acechase: [],
  }
}

function rowToEntry(row: {
  id: string
  name: string
  score: number
  at: number
  device: string
}): LeaderboardEntry {
  return {
    id: row.id,
    name: row.name,
    score: row.score,
    at: row.at,
    device: isDeviceType(row.device) ? row.device : 'desktop',
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
    acechase: Array.isArray(next.acechase) ? next.acechase : [],
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

function dayStartMs(key: number): number {
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
  const entries = period === 'all' ? history.slice() : filterByPeriod(history, period, now)
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

export async function getClosedBoard(
  game: GameSlug,
  period: ClosedPeriod,
  periodKey: number,
): Promise<LeaderboardEntry[]> {
  return topBoard(filterByClosedPeriod(await historyFor(game), period, periodKey))
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
    out[game] = (await getBoard(game, period, now, scope)).slice(0, capped)
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
      byPeriod[period] = (await getBoard(game, period, now)).slice(0, capped)
    }
    out[game] = byPeriod
  }
  return out
}

export type YouEntry = LeaderboardEntry & { rank: number }

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
    return at < 0 ? null : { ...view.entries[at], rank: at + 1 }
  }
  const pool = filterByNames(view.entries, scope)
  const at = pool.findIndex((e) => e.name === cleaned)
  return at < 0 ? null : { ...pool[at], rank: at + 1 }
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
  return placementsFromPool(filterByClosedPeriod(await historyFor(game), period, periodKey))
}

async function aggregateGlobalRanks(
  placementsForGame: (game: GameSlug) => Promise<{ name: string; place: number }[]>,
): Promise<GlobalRankEntry[]> {
  const byName = new Map<
    string,
    { score: number; games: number; byGame: Partial<Record<GameSlug, GlobalGamePlace>> }
  >()

  for (const game of ALLOWED_GAMES) {
    const placements = await placementsForGame(game)
    const fieldSize = placements.length
    for (const { name, place } of placements) {
      const points = placePoints(place, fieldSize)
      if (points <= 0) continue
      const row = byName.get(name) ?? { score: 0, games: 0, byGame: {} }
      row.score += points
      row.games += 1
      row.byGame[game] = { place, points, total: fieldSize }
      byName.set(name, row)
    }
  }

  const ranked = [...byName.entries()]
    .map(([name, row]) => ({ name, ...row }))
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
 * Only each player's total is kept. Where they placed on each game is read
 * off that game's board when a line is asked for, a handful at a time; kept
 * for everyone, it was most of the API's memory.
 */
/** A player's line in the standings: their total, and where it puts them. */
type StandingRow = { name: string; score: number; games: number; pos: number }

type StandingsView = {
  epoch: number
  window: string
  /** When the boards it was counted from were read. */
  asOf: number
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

/** Count one game's places into the tallies, or (sign -1) take them back out. */
function countPlaces(view: StandingsView, pool: PoolView, sign: 1 | -1) {
  for (let i = 0; i < pool.entries.length; i++) {
    const place = pool.placeAt[i]
    if (!place) continue
    const name = pool.entries[i].name
    const points = placePoints(place, pool.players)
    if (points <= 0) continue
    const row = view.tallies.get(name)
    if (sign > 0) {
      if (row) {
        row.score += points
        row.games += 1
      } else {
        view.tallies.set(name, { name, score: points, games: 1, pos: -1 })
      }
    } else if (row) {
      row.score -= points
      row.games -= 1
      if (row.games <= 0) view.tallies.delete(name)
    }
  }
  view.unsorted = true
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
function recountPlaces(view: StandingsView, had: PoolView, pool: PoolView, moved: Set<StandingRow>): boolean {
  const changes: { name: string; points: number; was: number }[] = []
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
    if (points !== was) changes.push({ name: entry.name, points, was })
  }
  if (kept !== had.players) return false
  for (const { name, points, was } of changes) {
    let row = view.tallies.get(name)
    if (!row) {
      row = { name, score: 0, games: 0, pos: -1 }
      view.tallies.set(name, row)
    }
    row.score += points - was
    if (was <= 0) row.games += 1
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
  for (const game of ALLOWED_GAMES) {
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
  let pools: PoolView[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    pools = []
    for (const game of ALLOWED_GAMES) pools.push(await poolView(game, period, now))
    if (pools.every((pool) => pool.epoch === pools[0].epoch)) break
  }
  const epoch = pools[0]?.epoch ?? 0
  const window = periodWindow(period, now)
  let view = standingsViews.get(period)
  if (!view || view.epoch !== epoch || view.window !== window) {
    view = { epoch, window, asOf, counted: new Map(), tallies: new Map(), order: [], unsorted: true }
    standingsViews.set(period, view)
  }
  const moved = new Set<StandingRow>()
  ALLOWED_GAMES.forEach((game, i) => {
    const pool = pools[i]
    const had = view.counted.get(game)
    if (had === pool) return
    if (!had || !recountPlaces(view, had, pool, moved)) {
      if (had) countPlaces(view, had, -1)
      countPlaces(view, pool, 1)
    }
    view.counted.set(game, pool)
  })
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
  if (scope) return aggregateGlobalRanks((game) => periodPlacements(game, period, now, scope))
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
