import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { recordScores } from './db/schema.js'
import { getClaim } from './names.js'
import { notify } from './notifications.js'
import { clock, gameLabel, spanWords } from './words.js'
import {
  ALLOWED_GAMES,
  boardDateKey,
  filterByPeriod,
  isDeviceType,
  legacyGameSlugs,
  periodWindow,
  playerRuns,
  previousBoardDateKey,
  resolveGameSlug,
  type DeviceType,
  type GameSlug,
  type LeaderboardEntry,
  type NameScope,
  type Period,
} from './store.js'

/** Default page of a record board, for callers that ask for no depth. */
const BOARD_PAGE = 100
const ASTEROIDS_WAVE_MAX = 20
const SNAKE_LENGTH_MILESTONE_MIN = 20
const SNAKE_LENGTH_MILESTONE_MAX = 100
const SNAKE_LENGTH_MILESTONE_STEP = 10
const CROSSWALK_ROW_MILESTONE_MIN = 50
const CROSSWALK_ROW_MILESTONE_MAX = 200
const CROSSWALK_ROW_MILESTONE_STEP = 25

export type RecordDirection = 'lower' | 'higher'

export type RecordDef = {
  id: string
  game: GameSlug
  label: string
  direction: RecordDirection
  /** Stored value unit (wave times are milliseconds). */
  unit: 'ms' | 'count'
}

export type RecordEntry = LeaderboardEntry

export type YouRecordEntry = RecordEntry & { rank: number }

type RecordsStore = Record<string, RecordEntry[]>

function boardKey(game: GameSlug, recordId: string) {
  return `${game}::${recordId}`
}

function buildAsteroidsWaveRecords(): RecordDef[] {
  const defs: RecordDef[] = []
  for (let wave = 1; wave <= ASTEROIDS_WAVE_MAX; wave++) {
    defs.push({
      id: `wave-time-${wave}`,
      game: 'asteroids',
      label: `Wave ${wave} clear`,
      direction: 'lower',
      unit: 'ms',
    })
  }
  return defs
}

const ASTEROIDS_HIGHEST_COMBO: RecordDef = {
  id: 'highest-combo',
  game: 'asteroids',
  label: 'Highest combo',
  direction: 'higher',
  unit: 'count',
}

const PATRIOT_DIRECT_STREAK: RecordDef = {
  id: 'direct-streak',
  game: 'patriot',
  label: 'Perfect hits in a row',
  direction: 'higher',
  unit: 'count',
}

function buildSnakeFastestLengthRecords(): RecordDef[] {
  const defs: RecordDef[] = []
  for (
    let length = SNAKE_LENGTH_MILESTONE_MIN;
    length <= SNAKE_LENGTH_MILESTONE_MAX;
    length += SNAKE_LENGTH_MILESTONE_STEP
  ) {
    defs.push({
      id: `fastest-length-${length}`,
      game: 'snake',
      label: `Fastest to length ${length}`,
      direction: 'lower',
      unit: 'ms',
    })
  }
  return defs
}

function buildCrosswalkFastestRowRecords(): RecordDef[] {
  const defs: RecordDef[] = []
  for (
    let rows = CROSSWALK_ROW_MILESTONE_MIN;
    rows <= CROSSWALK_ROW_MILESTONE_MAX;
    rows += CROSSWALK_ROW_MILESTONE_STEP
  ) {
    defs.push({
      id: `fastest-row-${rows}`,
      game: 'crosswalk',
      label: `Fastest to ${rows}`,
      direction: 'lower',
      unit: 'ms',
    })
  }
  return defs
}

const CROSSWALK_MOST_COINS: RecordDef = {
  id: 'most-coins',
  game: 'crosswalk',
  label: 'Most coins in a run',
  direction: 'higher',
  unit: 'count',
}

/** Rows broken without pausing — where playing it fast rather than safe counts. */
const CROSSWALK_LONGEST_CHAIN: RecordDef = {
  id: 'longest-chain',
  game: 'crosswalk',
  label: 'Longest chain',
  direction: 'higher',
  unit: 'count',
}

/**
 * Cars squeezed past in flight. Only ones taken mid-hop count — standing beside
 * a slow lane re-triggers a near miss every cooldown, so the alternative would
 * be a board that rewards parking next to traffic.
 */
const CROSSWALK_NEAR_MISSES: RecordDef = {
  id: 'near-misses',
  game: 'crosswalk',
  label: 'Closest calls in a run',
  direction: 'higher',
  unit: 'count',
}

const POP_CENTER_STREAK: RecordDef = {
  id: 'center-streak',
  game: 'pop',
  label: 'Perfect centers in a row',
  direction: 'higher',
  unit: 'count',
}

const STACKER_PERFECT_STREAK: RecordDef = {
  id: 'perfect-streak',
  game: 'stacker',
  label: 'Perfects in a row',
  direction: 'higher',
  unit: 'count',
}

const PELLETS_CRUMB_STREAK: RecordDef = {
  id: 'crumb-streak',
  game: 'pellets',
  label: 'Crumbs in a row',
  direction: 'higher',
  unit: 'count',
}

const CRUMBTRAIL_CRUMB_STREAK: RecordDef = {
  id: 'crumb-streak',
  game: 'crumbtrail',
  label: 'Crumbs in a row',
  direction: 'higher',
  unit: 'count',
}

const SNAKE_LONGEST: RecordDef = {
  id: 'longest',
  game: 'snake',
  label: 'Longest snake',
  direction: 'higher',
  unit: 'count',
}

/**
 * Blue chasers eaten. Only the frightened ones: a surge bounces a chaser away
 * rather than eating it, and the two pay on different ladders, so counting both
 * here would make the label mean something it does not say.
 */
const CRUMBTRAIL_GHOSTS: RecordDef = {
  id: 'chasers-eaten',
  game: 'crumbtrail',
  label: 'Chasers eaten in a run',
  direction: 'higher',
  unit: 'count',
}

const CRUMBTRAIL_ROWS: RecordDef = {
  id: 'most-rows',
  game: 'crumbtrail',
  label: 'Rows climbed',
  direction: 'higher',
  unit: 'count',
}

export const PLAY_DAYS_STREAK_ID = 'play-days-streak'
export const THRESHOLD_STREAK_ID = 'threshold-streak'

/** Minimum consecutive count before it lands on the record book. */
const MIN_CROSS_RUN_STREAK = 2

/**
 * Score a run must meet (or beat) to keep a “strong scores in a row” streak.
 * Spotter uses inverted time (higher board score = faster clear).
 */
export const SCORE_STREAK_THRESHOLDS: Record<GameSlug, number> = {
  barrage: 4000,
  frenzy: 3000,
  asteroids: 1000,
  patriot: 1000,
  snake: 500,
  crosswalk: 75,
  stacker: 15,
  centroid: 6000,
  pop: 300,
  simon: 10,
  spotter: 955_000, // ≈ under 45s
  pellets: 2000,
  findbug: 940_000, // ≈ a full five-scene run under 60s
  crumbtrail: 10_000,
  bop: 25,
  putt: 2000,
  fireflies: 60,
}

function thresholdStreakLabel(game: GameSlug, threshold: number): string {
  if (game === 'spotter') return 'Sub-45s clears in a row'
  if (game === 'findbug') return 'Sub-60s sweeps in a row'
  return `Scores over ${threshold.toLocaleString()} in a row`
}

function buildCrossRunStreakRecords(): RecordDef[] {
  const defs: RecordDef[] = []
  for (const game of ALLOWED_GAMES) {
    const threshold = SCORE_STREAK_THRESHOLDS[game]
    defs.push({
      id: PLAY_DAYS_STREAK_ID,
      game,
      label: 'Days played in a row',
      direction: 'higher',
      unit: 'count',
    })
    defs.push({
      id: THRESHOLD_STREAK_ID,
      game,
      label: thresholdStreakLabel(game, threshold),
      direction: 'higher',
      unit: 'count',
    })
  }
  return defs
}

const RECORD_DEFS: RecordDef[] = [
  ...buildCrossRunStreakRecords(),
  ASTEROIDS_HIGHEST_COMBO,
  PATRIOT_DIRECT_STREAK,
  CROSSWALK_MOST_COINS,
  CROSSWALK_LONGEST_CHAIN,
  CROSSWALK_NEAR_MISSES,
  POP_CENTER_STREAK,
  STACKER_PERFECT_STREAK,
  PELLETS_CRUMB_STREAK,
  CRUMBTRAIL_ROWS,
  CRUMBTRAIL_CRUMB_STREAK,
  CRUMBTRAIL_GHOSTS,
  SNAKE_LONGEST,
  ...buildAsteroidsWaveRecords(),
  ...buildSnakeFastestLengthRecords(),
  ...buildCrosswalkFastestRowRecords(),
]

const DEFS_BY_KEY = new Map(
  RECORD_DEFS.map((def) => [`${def.game}::${def.id}`, def] as const),
)

export function listRecordDefs(game: GameSlug): RecordDef[] {
  return RECORD_DEFS.filter((def) => def.game === game)
}

export function getRecordDef(game: string, recordId: string): RecordDef | null {
  const resolved = resolveGameSlug(game)
  if (!resolved) return null
  return DEFS_BY_KEY.get(`${resolved}::${recordId}`) ?? null
}

export function isAsteroidsWaveTimeRecord(recordId: string): number | null {
  const match = /^wave-time-(\d+)$/.exec(recordId)
  if (!match) return null
  const wave = Number(match[1])
  if (!Number.isInteger(wave) || wave < 1 || wave > ASTEROIDS_WAVE_MAX) return null
  return wave
}

export function isSnakeFastestLengthRecord(recordId: string): number | null {
  const match = /^fastest-length-(\d+)$/.exec(recordId)
  if (!match) return null
  const length = Number(match[1])
  if (
    !Number.isInteger(length) ||
    length < SNAKE_LENGTH_MILESTONE_MIN ||
    length > SNAKE_LENGTH_MILESTONE_MAX ||
    length % SNAKE_LENGTH_MILESTONE_STEP !== 0
  ) {
    return null
  }
  return length
}

export function isCrosswalkFastestRowRecord(recordId: string): number | null {
  const match = /^fastest-row-(\d+)$/.exec(recordId)
  if (!match) return null
  const rows = Number(match[1])
  if (
    !Number.isInteger(rows) ||
    rows < CROSSWALK_ROW_MILESTONE_MIN ||
    rows > CROSSWALK_ROW_MILESTONE_MAX ||
    rows % CROSSWALK_ROW_MILESTONE_STEP !== 0
  ) {
    return null
  }
  return rows
}

function normalizeEntry(raw: unknown): RecordEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<RecordEntry>
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.score !== 'number') {
    return null
  }
  if (!Number.isFinite(row.score) || row.score < 0) return null
  return {
    id: row.id,
    name: row.name,
    score: Math.floor(row.score),
    at: typeof row.at === 'number' ? row.at : 0,
    device: isDeviceType(row.device) ? row.device : 'desktop',
  }
}

function rowToEntry(row: {
  id: string
  name: string
  score: number
  at: number
  device: string
}): RecordEntry {
  return {
    id: row.id,
    name: row.name,
    score: row.score,
    at: row.at,
    device: isDeviceType(row.device) ? row.device : 'desktop',
  }
}

export async function replaceAllRecords(next: RecordsStore) {
  const cleaned: { game: string; recordId: string; entry: RecordEntry }[] = []
  for (const [key, rows] of Object.entries(next ?? {})) {
    if (!Array.isArray(rows)) continue
    const sep = key.indexOf('::')
    if (sep < 0) continue
    const game = key.slice(0, sep)
    const recordId = key.slice(sep + 2)
    for (const raw of rows) {
      const entry = normalizeEntry(raw)
      if (entry) cleaned.push({ game, recordId, entry })
    }
  }
  invalidateRecordHistoryCache()
  await db().transaction(async (tx) => {
    await tx.delete(recordScores)
    const chunk = 200
    for (let i = 0; i < cleaned.length; i += chunk) {
      const slice = cleaned.slice(i, i + chunk)
      await tx.insert(recordScores).values(
        slice.map(({ game, recordId, entry }) => ({
          id: entry.id,
          game,
          recordId,
          name: entry.name,
          score: entry.score,
          at: entry.at,
          device: entry.device,
        })),
      )
    }
  })
}

export async function isRecordsStoreEmpty() {
  const rows = await db().select({ id: recordScores.id }).from(recordScores).limit(1)
  return rows.length === 0
}

function sortEntries(entries: RecordEntry[], direction: RecordDirection) {
  return [...entries].sort((a, b) => {
    if (direction === 'lower') {
      if (a.score !== b.score) return a.score - b.score
    } else if (a.score !== b.score) {
      return b.score - a.score
    }
    return a.at - b.at
  })
}

function isBetter(
  next: number,
  previous: number,
  direction: RecordDirection,
): boolean {
  return direction === 'lower' ? next < previous : next > previous
}

/** A book's order: its best first (lowest for a time, highest for a count), the earlier of two equal. */
function recordOrder(direction: RecordDirection) {
  return (a: RecordEntry, b: RecordEntry) => {
    if (a.score !== b.score) return direction === 'lower' ? a.score - b.score : b.score - a.score
    return a.at - b.at
  }
}

/*
 * Record history, read once and kept current: the same shape as the score
 * history in store.ts, and for the same reason. A new record goes into its
 * place in the copy as it lands. It used to throw the copy away, and games
 * post records all through a run, so under a crowd nearly every book read
 * waited on the whole record table being read again. The copy is still read
 * again every ten minutes, in case a script changed the table, and at once
 * when something rewrites records wholesale (invalidateRecordHistoryCache).
 */
const HISTORY_TTL_MS = 10 * 60_000

type RecordCopy = { at: number; epoch: number; byKey: Map<string, RecordEntry[]> }

let historyCache: RecordCopy | null = null
let historyLoading: Promise<RecordCopy> | null = null
let historyEpoch = 0
/** Counts wholesale rewrites: a reading begun before one is handed out but not kept. */
let historyInvalidations = 0
/** Records saved while a reading was under way: put into the new copy when it lands. */
let savedDuringLoad: { key: string; entry: RecordEntry }[] = []
/** Moves each time a book takes a record in place; a view of the book is redrawn when it does. */
const bookVersions = new Map<string, number>()

export function invalidateRecordHistoryCache() {
  historyCache = null
  historyInvalidations++
}

async function loadRecordCopy(): Promise<RecordCopy> {
  if (historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache
  if (historyLoading) return historyLoading
  savedDuringLoad = []
  const invalidationsAtStart = historyInvalidations
  historyLoading = (async () => {
    const rows = await db().select().from(recordScores)
    const byKey = new Map<string, RecordEntry[]>()
    for (const row of rows) {
      const key = `${row.game}::${row.recordId}`
      const list = byKey.get(key) ?? []
      list.push(rowToEntry(row))
      byKey.set(key, list)
    }
    // A record saved while the table was being read may or may not be in what came back.
    for (const { key, entry } of savedDuringLoad) {
      const list = byKey.get(key) ?? []
      if (!list.some((e) => e.id === entry.id)) list.push(entry)
      byKey.set(key, list)
    }
    savedDuringLoad = []
    const copy: RecordCopy = { at: Date.now(), epoch: ++historyEpoch, byKey }
    // Rewritten wholesale while this was reading: good enough to answer with, not to keep.
    if (invalidationsAtStart === historyInvalidations) historyCache = copy
    return copy
  })().finally(() => {
    historyLoading = null
  })
  return historyLoading
}

/*
 * A book's every run in its order, sorted once, and each period's board drawn
 * from it once: kept until the book takes a record, the history is read
 * again, or the period moves on. Before, every book read sorted every run of
 * every book it touched, per request: a game's whole book was two dozen sorts.
 */
type BookView = { epoch: number; version: number; sorted: RecordEntry[] }

type RecordBoardView = {
  epoch: number
  version: number
  window: string
  /** The book's runs in the period, in its order. */
  runs: RecordEntry[]
  /** Each player's best of them, in order: the board. */
  ranked: RecordEntry[]
  /** Each player's index in ranked. */
  rankAt: Map<string, number>
}

const bookViews = new Map<string, BookView>()
const boardViews = new Map<string, RecordBoardView>()

/** A record just written to the table, put into the history, and its book, in place. */
function rememberRecord(game: GameSlug, recordId: string, def: RecordDef, entry: RecordEntry) {
  const key = `${game}::${recordId}`
  if (historyLoading) savedDuringLoad.push({ key, entry })
  const version = bookVersions.get(key) ?? 0
  if (historyCache) {
    const list = historyCache.byKey.get(key) ?? []
    list.push(entry)
    historyCache.byKey.set(key, list)
    // The sorted book, if it is drawn from this copy and current, takes the run in its place.
    const book = bookViews.get(key)
    if (book && book.epoch === historyCache.epoch && book.version === version) {
      const order = recordOrder(def.direction)
      let lo = 0
      let hi = book.sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (order(book.sorted[mid], entry) <= 0) lo = mid + 1
        else hi = mid
      }
      book.sorted.splice(lo, 0, entry)
      book.version = version + 1
    }
  }
  bookVersions.set(key, version + 1)
}

async function bookView(game: GameSlug, recordId: string, def: RecordDef): Promise<BookView> {
  const copy = await loadRecordCopy()
  const key = `${game}::${recordId}`
  const version = bookVersions.get(key) ?? 0
  const hit = bookViews.get(key)
  if (hit && hit.epoch === copy.epoch && hit.version === version) return hit
  const runs: RecordEntry[] = []
  for (const g of [game, ...legacyGameSlugs(game)]) {
    const list = copy.byKey.get(`${g}::${recordId}`)
    if (list) runs.push(...list)
  }
  const view: BookView = { epoch: copy.epoch, version, sorted: sortEntries(runs, def.direction) }
  bookViews.set(key, view)
  return view
}

async function boardView(
  game: GameSlug,
  recordId: string,
  def: RecordDef,
  period: Period,
  now = Date.now(),
): Promise<RecordBoardView> {
  const book = await bookView(game, recordId, def)
  const window = periodWindow(period, now)
  const key = `${game}::${recordId}:${period}`
  const hit = boardViews.get(key)
  if (hit && hit.epoch === book.epoch && hit.version === book.version && hit.window === window) return hit
  const runs = period === 'all' ? book.sorted.slice() : filterByPeriod(book.sorted, period, now)
  const ranked = bestPerPlayer(runs)
  const view: RecordBoardView = {
    epoch: book.epoch,
    version: book.version,
    window,
    runs,
    ranked,
    rankAt: new Map(ranked.map((entry, i) => [entry.name, i])),
  }
  boardViews.set(key, view)
  return view
}

function filterByNames<T extends { name: string }>(entries: T[], scope?: NameScope): T[] {
  if (!scope) return entries
  return entries.filter((e) => scope.has(e.name))
}

/** A book's board for a period, one row per player; narrowed to a group when there is a scope. */
function rankedFor(view: RecordBoardView, scope?: NameScope): RecordEntry[] {
  return scope ? bestPerPlayer(filterByNames(view.runs, scope)) : view.ranked
}

export async function getRecordBoard(
  game: GameSlug,
  recordId: string,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<RecordEntry[]> {
  const def = getRecordDef(game, recordId)
  if (!def) return []
  return rankedFor(await boardView(game, recordId, def, period, now), scope).slice(0, BOARD_PAGE)
}

/**
 * One window onto a record board, and how deep it goes.
 *
 * A record board is one row per player, so `total` is the size of the field
 * a rank is measured against — the number that makes 5,321st mean something.
 */
export async function getRecordBoardPage(
  game: GameSlug,
  recordId: string,
  period: Period = 'all',
  opts: { offset?: number; limit?: number; now?: number; scope?: NameScope } = {},
): Promise<{ entries: RecordEntry[]; total: number }> {
  const def = getRecordDef(game, recordId)
  if (!def) return { entries: [], total: 0 }
  const now = opts.now ?? Date.now()
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? BOARD_PAGE))
  const ranked = rankedFor(await boardView(game, recordId, def, period, now), opts.scope)
  return { entries: ranked.slice(offset, offset + limit), total: ranked.length }
}

export async function bestRecordForName(
  game: GameSlug,
  recordId: string,
  name: string,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<YouRecordEntry | null> {
  const def = getRecordDef(game, recordId)
  if (!def) return null
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return null
  const view = await boardView(game, recordId, def, period, now)
  if (!scope) {
    const at = view.rankAt.get(cleaned)
    return at == null ? null : { ...view.ranked[at], rank: at + 1 }
  }
  const ranked = rankedFor(view, scope)
  const at = ranked.findIndex((e) => e.name === cleaned)
  return at < 0 ? null : { ...ranked[at], rank: at + 1 }
}

/**
 * A record's story: every run that beat everything before it, oldest first.
 *
 * A run that improves on its player's own best is always kept, and a run that
 * sets a record always does, so this is the whole story rather than a sample.
 * A tie never takes a record: whoever reached the score first keeps it. Given
 * a name, the same walk over that player's runs alone: their best, each time
 * it moved.
 */
export async function getRecordProgression(
  game: GameSlug,
  recordId: string,
  period: Period = 'all',
  opts: { now?: number; scope?: NameScope; name?: string } = {},
): Promise<RecordEntry[]> {
  const def = getRecordDef(game, recordId)
  if (!def) return []
  const book = await bookView(game, recordId, def)
  let pool = filterByNames(filterByPeriod(book.sorted, period, opts.now ?? Date.now()), opts.scope)
  if (opts.name !== undefined) {
    const cleaned = opts.name.trim().slice(0, 12).toUpperCase()
    pool = pool.filter((e) => e.name === cleaned)
  }
  const out: RecordEntry[] = []
  for (const entry of [...pool].sort((a, b) => a.at - b.at)) {
    const best = out[out.length - 1]
    if (!best || isBetter(entry.score, best.score, def.direction)) out.push(entry)
  }
  return out
}

export type GameRecordSummary = RecordDef & {
  top: RecordEntry | null
  /** The best of the other players: what the holder is ahead of. */
  second: RecordEntry | null
  /** Players on the board, one each. */
  players: number
  /** Where `name` stands on it, when a name was asked about; null when they are not on it. */
  you?: YouRecordEntry | null
}

/**
 * Every record in a game's book with its holder, the runner-up and how many
 * players are on it, and, given a name, where that player stands on each, so
 * a book can be drawn in one request rather than one per record.
 */
export async function listGameRecords(
  game: GameSlug,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
  name?: string,
): Promise<{ records: GameRecordSummary[] }> {
  const cleaned = name?.trim().slice(0, 12).toUpperCase() ?? ''
  const records: GameRecordSummary[] = []
  for (const def of listRecordDefs(game)) {
    const view = await boardView(game, def.id, def, period, now)
    const ranked = rankedFor(view, scope)
    const row: GameRecordSummary = {
      ...def,
      top: ranked[0] ?? null,
      second: ranked[1] ?? null,
      players: ranked.length,
    }
    if (cleaned) {
      const at = scope ? ranked.findIndex((e) => e.name === cleaned) : (view.rankAt.get(cleaned) ?? -1)
      row.you = at >= 0 ? { ...ranked[at], rank: at + 1 } : null
    }
    records.push(row)
  }
  return { records }
}

/**
 * Best entry per player, in board order.
 *
 * Every qualifying run writes its own row, so without this a player who set
 * the same streak on three runs takes the whole podium with three copies of
 * one result. Keeping only their best also means beating your own mark
 * replaces it rather than sitting next to it.
 */
function bestPerPlayer(sorted: RecordEntry[]): RecordEntry[] {
  const seen = new Set<string>()
  const out: RecordEntry[] = []
  for (const entry of sorted) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out
}

export async function addRecord(
  game: GameSlug,
  recordId: string,
  name: string,
  score: number,
  device: DeviceType = 'desktop',
): Promise<{
  improved: boolean
  entry: RecordEntry | null
  rank: number | null
  ranks: Partial<Record<Period, number>>
  board: RecordEntry[]
  totalEntries: number
}> {
  const def = getRecordDef(game, recordId)
  if (!def) {
    throw Object.assign(new Error('Unknown record'), { status: 404 })
  }
  if (!Number.isFinite(score) || score < 0) {
    throw Object.assign(new Error('Invalid score'), { status: 400 })
  }
  const value = Math.floor(score)
  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  const now = Date.now()
  const allTime = await boardView(game, recordId, def, 'all', now)
  // Who holds the board right now, so a change of hands can be spotted below.
  const priorLeader = allTime.ranked[0] ?? null
  /** The player's own best in a period: their row on that period's board. */
  const bestIn = async (period: Period) => {
    const view = await boardView(game, recordId, def, period, now)
    const at = view.rankAt.get(cleaned)
    return at == null ? undefined : view.ranked[at]
  }
  const improvesPeriod = async (period: Period) => {
    const best = await bestIn(period)
    return !best || isBetter(value, best.score, def.direction)
  }
  /*
   * Only store a run that beats the player's own best in some period. The
   * board-space check used to let anything in while a board had room, which
   * is how one streak of two ended up on the podium three times over.
   */
  const accept =
    (await improvesPeriod('all')) ||
    (await improvesPeriod('daily')) ||
    (await improvesPeriod('weekly')) ||
    (await improvesPeriod('monthly'))
  if (!accept) {
    const board = await getRecordBoard(game, recordId, 'all')
    const you = await bestRecordForName(game, recordId, cleaned, 'all')
    const previousBest = (await bestIn('all')) ?? null
    return {
      improved: false,
      entry: previousBest,
      rank: you?.rank ?? null,
      ranks: {},
      board,
      totalEntries: (await bookView(game, recordId, def)).sorted.length,
    }
  }

  const entry: RecordEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score: value,
    at: Date.now(),
    device: isDeviceType(device) ? device : 'desktop',
  }

  /*
   * Every attempt is kept. The old prune held the newest 500 rows per board,
   * which quietly dropped a player's own best once the board got busy. Once
   * written, the run goes into the history in place (rememberRecord): no
   * reading the whole table back.
   */
  await db().insert(recordScores).values({
    id: entry.id,
    game,
    recordId,
    name: entry.name,
    score: entry.score,
    at: entry.at,
    device: entry.device,
  })
  rememberRecord(game, recordId, def, entry)

  const leader = (await boardView(game, recordId, def, 'all')).ranked[0] ?? null
  await notifyRecordTaken(game, recordId, def, priorLeader, cleaned, leader, now)
  const ranks: Partial<Record<Period, number>> = {}
  for (const period of ['daily', 'weekly', 'monthly', 'all'] as const) {
    const view = await boardView(game, recordId, def, period)
    const at = view.rankAt.get(cleaned)
    if (at != null && view.ranked[at].id === entry.id) ranks[period] = at + 1
  }

  return {
    improved: true,
    entry,
    rank: ranks.all ?? ranks.daily ?? null,
    ranks,
    board: await getRecordBoard(game, recordId, 'all'),
    totalEntries: (await bookView(game, recordId, def)).sorted.length,
  }
}

export type CrossRunStreakHit = {
  recordId: string
  label: string
  value: number
  improved: boolean
  rank: number | null
  totalEntries: number
}

/** A player's runs on a game, newest first: from the history the boards keep, not another query per save. */
async function playerRunHistory(
  game: GameSlug,
  name: string,
): Promise<{ score: number; at: number }[]> {
  return playerRuns(game, name)
}

/** Consecutive calendar days (BOARD_TZ) ending today that include at least one run. */
export function computePlayDaysStreak(timestamps: number[], now = Date.now()): number {
  if (!timestamps.length) return 0
  const days = new Set(timestamps.map((at) => boardDateKey(at)))
  let cursor = boardDateKey(now)
  if (!days.has(cursor)) return 0
  let streak = 0
  while (days.has(cursor)) {
    streak += 1
    cursor = previousBoardDateKey(cursor)
  }
  return streak
}

/** Consecutive recent runs (newest first) at or above the game threshold. */
export function computeThresholdStreak(
  runs: { score: number; at: number }[],
  threshold: number,
): number {
  let streak = 0
  for (const run of runs) {
    if (run.score >= threshold) streak += 1
    else break
  }
  return streak
}

/**
 * After a leaderboard score is saved, refresh cross-run streak record books.
 * Only writes when the streak is at least {@link MIN_CROSS_RUN_STREAK}.
 */
export async function updateCrossRunStreakRecords(
  game: GameSlug,
  name: string,
  _score: number,
  device: DeviceType = 'desktop',
  now = Date.now(),
): Promise<CrossRunStreakHit[]> {
  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  const history = await playerRunHistory(game, cleaned)
  const hits: CrossRunStreakHit[] = []

  const playDays = computePlayDaysStreak(
    history.map((r) => r.at),
    now,
  )
  if (playDays >= MIN_CROSS_RUN_STREAK) {
    const def = getRecordDef(game, PLAY_DAYS_STREAK_ID)
    if (def) {
      const result = await addRecord(game, PLAY_DAYS_STREAK_ID, cleaned, playDays, device)
      hits.push({
        recordId: PLAY_DAYS_STREAK_ID,
        label: def.label,
        value: playDays,
        improved: result.improved,
        rank: result.rank,
        totalEntries: result.totalEntries,
      })
    }
  }

  const threshold = SCORE_STREAK_THRESHOLDS[game]
  const thresholdStreak = computeThresholdStreak(history, threshold)
  if (thresholdStreak >= MIN_CROSS_RUN_STREAK) {
    const def = getRecordDef(game, THRESHOLD_STREAK_ID)
    if (def) {
      const result = await addRecord(game, THRESHOLD_STREAK_ID, cleaned, thresholdStreak, device)
      hits.push({
        recordId: THRESHOLD_STREAK_ID,
        label: def.label,
        value: thresholdStreak,
        improved: result.improved,
        rank: result.rank,
        totalEntries: result.totalEntries,
      })
    }
  }

  return hits
}

export async function renamePlayerAcrossRecords(
  fromRaw: string,
  toRaw: string,
): Promise<{ from: string; to: string; updated: number }> {
  const from = fromRaw.trim().slice(0, 12).toUpperCase()
  const to = toRaw.trim().slice(0, 12).toUpperCase()
  if (!from || !to || from === to) return { from, to, updated: 0 }

  invalidateRecordHistoryCache()
  const updated = await db()
    .update(recordScores)
    .set({ name: to })
    .where(eq(recordScores.name, from))
    .returning({ id: recordScores.id })
  return { from, to, updated: updated.length }
}

export {
  ASTEROIDS_WAVE_MAX,
  ASTEROIDS_HIGHEST_COMBO,
  PATRIOT_DIRECT_STREAK,
  PELLETS_CRUMB_STREAK,
  CRUMBTRAIL_ROWS,
  CRUMBTRAIL_CRUMB_STREAK,
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_STEP,
  CROSSWALK_ROW_MILESTONE_MIN,
  CROSSWALK_ROW_MILESTONE_MAX,
  CROSSWALK_ROW_MILESTONE_STEP,
}

/** A record's value the way its book prints it: 47.5s for a clock, 23 for a count. */
function recordValue(def: RecordDef, value: number): string {
  return def.unit === 'ms' ? clock(value) : value.toLocaleString('en-US')
}

/**
 * Tell the previous holder that a record board changed hands.
 *
 * Deliberately narrow: only the player who actually held #1 and just lost it
 * hears anything. "Someone posted a good score" would fire on every submission
 * across 65 boards; "you are no longer the record holder" fires only when a
 * player's own standing changed, which is bounded by the handful of boards
 * anyone actually leads.
 *
 * One row per record: losing three in a day is three rows, each naming who
 * took it and by how much, rather than one row named after the last.
 *
 * Inbox only — never pushed. The record will still be gone when they next open
 * the app, so there is nothing here worth a buzz.
 */
async function notifyRecordTaken(
  game: GameSlug,
  recordId: string,
  def: RecordDef,
  priorLeader: RecordEntry | null,
  taker: string,
  leader: RecordEntry | null,
  now: number,
) {
  if (!priorLeader || priorLeader.name === taker) return
  if (leader?.name !== taker) return

  try {
    const claim = await getClaim(priorLeader.name)
    if (!claim?.accountId) return
    await notify({
      accountId: claim.accountId,
      kind: 'record-lost',
      title: `${taker} took your ${def.label} record`,
      body: `${gameLabel(game)}, ${recordValue(def, leader.score)} to your ${recordValue(def, priorLeader.score)}. You held it for ${spanWords(now - priorLeader.at)}.`,
      href: `/records/${game}/${recordId}/all`,
      meta: { actor: taker, game, playHref: `/games/${game}/play` },
      digestKey: `record-lost:${game}:${recordId}`,
      now,
    })
  } catch {
    // A record stands or falls on its own; telling someone about it is extra.
  }
}
