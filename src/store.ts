import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'leaderboards.json')

export const ALLOWED_GAMES = [
  'stacker',
  'patriot',
  'snake',
  'pop',
  'dead-center',
  'asteroids',
  'simon',
  'crosswalk',
] as const
export type GameSlug = (typeof ALLOWED_GAMES)[number]

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

function normalizeEntry(raw: unknown): { entry: LeaderboardEntry | null; changed: boolean } {
  if (!raw || typeof raw !== 'object') return { entry: null, changed: false }
  const row = raw as Partial<LeaderboardEntry>
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.score !== 'number') {
    return { entry: null, changed: false }
  }
  const device = isDeviceType(row.device) ? row.device : 'desktop'
  return {
    entry: {
      id: row.id,
      name: row.name,
      score: row.score,
      at: typeof row.at === 'number' ? row.at : 0,
      device,
    },
    changed: row.device !== device,
  }
}

function normalizeBoard(raw: unknown): { entries: LeaderboardEntry[]; changed: boolean } {
  if (!Array.isArray(raw)) return { entries: [], changed: false }
  let changed = false
  const entries: LeaderboardEntry[] = []
  for (const row of raw) {
    const next = normalizeEntry(row)
    if (!next.entry) {
      changed = true
      continue
    }
    if (next.changed) changed = true
    entries.push(next.entry)
  }
  return { entries, changed }
}

type Store = Record<GameSlug, LeaderboardEntry[]>

const MAX_BOARD = 100
const MAX_HISTORY = 500
const RETAIN_DAYS = 100

function emptyStore(): Store {
  return {
    stacker: [],
    patriot: [],
    snake: [],
    'pop': [],
    'dead-center': [],
    asteroids: [],
    simon: [],
    crosswalk: [],
  }
}

function ensureStore(): Store {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!fs.existsSync(STORE_PATH)) {
    const empty = emptyStore()
    fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2))
    return empty
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Store
    const stacker = normalizeBoard(parsed.stacker)
    const patriot = normalizeBoard(parsed.patriot)
    const snake = normalizeBoard(parsed.snake)
    const pop = normalizeBoard(parsed.pop)
    const deadCenter = normalizeBoard(parsed['dead-center'])
    const asteroids = normalizeBoard(parsed.asteroids)
    const simon = normalizeBoard(parsed.simon)
    const crosswalk = normalizeBoard(parsed.crosswalk)
    const store: Store = {
      stacker: stacker.entries,
      patriot: patriot.entries,
      snake: snake.entries,
      pop: pop.entries,
      'dead-center': deadCenter.entries,
      asteroids: asteroids.entries,
      simon: simon.entries,
      crosswalk: crosswalk.entries,
    }
    const changed =
      stacker.changed ||
      patriot.changed ||
      snake.changed ||
      pop.changed ||
      deadCenter.changed ||
      asteroids.changed ||
      simon.changed ||
      crosswalk.changed ||
      !Array.isArray(parsed.crosswalk)
    if (changed) writeStore(store)
    return store
  } catch {
    return emptyStore()
  }
}

function writeStore(store: Store) {
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, STORE_PATH)
}

export function loadStore(): Store {
  return ensureStore()
}

export function replaceAllBoards(next: Store) {
  writeStore({
    stacker: Array.isArray(next.stacker) ? next.stacker : [],
    patriot: Array.isArray(next.patriot) ? next.patriot : [],
    snake: Array.isArray(next.snake) ? next.snake : [],
    'pop': Array.isArray(next['pop']) ? next['pop'] : [],
    'dead-center': Array.isArray(next['dead-center']) ? next['dead-center'] : [],
    asteroids: Array.isArray(next.asteroids) ? next.asteroids : [],
    simon: Array.isArray(next.simon) ? next.simon : [],
    crosswalk: Array.isArray(next.crosswalk) ? next.crosswalk : [],
  })
}

export function replaceGameBoard(game: GameSlug, entries: LeaderboardEntry[]) {
  const store = loadStore()
  store[game] = Array.isArray(entries) ? entries : []
  writeStore(store)
}

function sortByScore(entries: LeaderboardEntry[]) {
  return [...entries].sort((a, b) => b.score - a.score || a.at - b.at)
}

function topBoard(entries: LeaderboardEntry[]) {
  return sortByScore(entries).slice(0, MAX_BOARD)
}

type Ymd = { y: number; m: number; d: number; weekday: string }

function ymdInTz(ms: number, timeZone = BOARD_TZ): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    weekday: get('weekday'),
  }
}

function dateKey(y: number, m: number, d: number) {
  return y * 10_000 + m * 100 + d
}

function keyOf(ms: number) {
  const { y, m, d } = ymdInTz(ms)
  return dateKey(y, m, d)
}

/** Monday-start week key (YYYYMMDD of that Monday) in BOARD_TZ. */
function weekStartKey(ms: number) {
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
  return (ALLOWED_GAMES as readonly string[]).includes(game)
}

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value)
}

export function filterByPeriod(
  entries: LeaderboardEntry[],
  period: Period,
  now = Date.now(),
): LeaderboardEntry[] {
  if (period === 'all') return entries

  if (period === 'daily') {
    const today = keyOf(now)
    return entries.filter((e) => keyOf(e.at) === today)
  }

  if (period === 'monthly') {
    const { y, m } = ymdInTz(now)
    return entries.filter((e) => {
      const p = ymdInTz(e.at)
      return p.y === y && p.m === m
    })
  }

  // weekly — Monday through today in BOARD_TZ
  const start = weekStartKey(now)
  const today = keyOf(now)
  return entries.filter((e) => {
    const k = keyOf(e.at)
    return k >= start && k <= today
  })
}

function historyFor(game: GameSlug): LeaderboardEntry[] {
  return ensureStore()[game] ?? []
}

export function getBoard(
  game: GameSlug,
  period: Period = 'all',
  now = Date.now(),
): LeaderboardEntry[] {
  return topBoard(filterByPeriod(historyFor(game), period, now))
}

export type PeriodBoardSummary = Record<Period, LeaderboardEntry[]>

/** Top N entries per game and period — one pass over local store. */
export function boardsSummary(limit = 3, now = Date.now()): Record<GameSlug, PeriodBoardSummary> {
  const capped = Math.min(10, Math.max(1, Math.floor(limit)) || 3)
  const out = {} as Record<GameSlug, PeriodBoardSummary>
  for (const game of ALLOWED_GAMES) {
    const byPeriod = {} as PeriodBoardSummary
    for (const period of PERIODS) {
      byPeriod[period] = getBoard(game, period, now).slice(0, capped)
    }
    out[game] = byPeriod
  }
  return out
}

export type YouEntry = LeaderboardEntry & { rank: number }

export function bestForName(
  game: GameSlug,
  name: string,
  period: Period = 'all',
  now = Date.now(),
): YouEntry | null {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return null
  const pool = sortByScore(filterByPeriod(historyFor(game), period, now))
  const mine = pool.filter((e) => e.name === cleaned)
  if (!mine.length) return null
  const best = mine[0]
  return { ...best, rank: pool.findIndex((e) => e.id === best.id) + 1 }
}

export function bestsForName(name: string): Partial<Record<GameSlug, number>> {
  const out: Partial<Record<GameSlug, number>> = {}
  for (const game of ALLOWED_GAMES) {
    const row = bestForName(game, name, 'all')
    if (row) out[game] = row.score
  }
  return out
}

/** Placement points: 1st = 100 … 100th = 1. */
export function placePoints(place: number): number {
  if (place < 1 || place > MAX_BOARD) return 0
  return Math.max(0, 101 - place)
}

export type GlobalGamePlace = {
  place: number
  points: number
}

export type GlobalRankEntry = {
  name: string
  rank: number
  score: number
  games: number
  byGame: Partial<Record<GameSlug, GlobalGamePlace>>
}

/** Unique best-per-name on a period board, ordered for placement. */
function periodPlacements(
  game: GameSlug,
  period: Period,
  now = Date.now(),
): { name: string; place: number }[] {
  const pool = sortByScore(filterByPeriod(historyFor(game), period, now))
  const seen = new Set<string>()
  const bests: string[] = []
  for (const entry of pool) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    bests.push(entry.name)
    if (bests.length >= MAX_BOARD) break
  }
  return bests.map((name, i) => ({ name, place: i + 1 }))
}

export function globalRanks(period: Period = 'all', now = Date.now()): GlobalRankEntry[] {
  const byName = new Map<
    string,
    { score: number; games: number; byGame: Partial<Record<GameSlug, GlobalGamePlace>> }
  >()

  for (const game of ALLOWED_GAMES) {
    for (const { name, place } of periodPlacements(game, period, now)) {
      const points = placePoints(place)
      if (points <= 0) continue
      const row = byName.get(name) ?? { score: 0, games: 0, byGame: {} }
      row.score += points
      row.games += 1
      row.byGame[game] = { place, points }
      byName.set(name, row)
    }
  }

  const ranked = [...byName.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.games !== a.games) return b.games - a.games
      return a.name.localeCompare(b.name)
    })

  return ranked.map((row, i) => ({
    name: row.name,
    rank: i + 1,
    score: row.score,
    games: row.games,
    byGame: row.byGame,
  }))
}

export function rankForName(
  name: string,
  neighborRadius = 2,
  period: Period = 'all',
  now = Date.now(),
): {
  rank: number | null
  score: number
  totalPlayers: number
  byGame: Partial<Record<GameSlug, GlobalGamePlace>>
  nearby: GlobalRankEntry[]
} {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  const all = globalRanks(period, now)
  if (!cleaned) {
    return {
      rank: null,
      score: 0,
      totalPlayers: all.length,
      byGame: {},
      nearby: [],
    }
  }
  const me = all.find((row) => row.name === cleaned)
  if (!me) {
    return {
      rank: null,
      score: 0,
      totalPlayers: all.length,
      byGame: {},
      nearby: [],
    }
  }
  const idx = me.rank - 1
  const start = Math.max(0, idx - neighborRadius)
  const end = Math.min(all.length, idx + neighborRadius + 1)
  return {
    rank: me.rank,
    score: me.score,
    totalPlayers: all.length,
    byGame: me.byGame,
    nearby: all.slice(start, end),
  }
}

export function qualifies(
  game: GameSlug,
  score: number,
  period: Period = 'daily',
  now = Date.now(),
): boolean {
  if (score <= 0) return false
  const board = getBoard(game, period, now)
  if (board.length < MAX_BOARD) return true
  return score > board[board.length - 1].score
}

/** True if the score makes any period board. */
export function qualifiesAny(game: GameSlug, score: number, now = Date.now()): boolean {
  return PERIODS.some((period) => qualifies(game, score, period, now))
}

export function rankForScore(
  game: GameSlug,
  score: number,
  period: Period = 'daily',
  now = Date.now(),
): number | null {
  if (score <= 0) return null
  // Place among every score in the period — not just the displayed top 10
  const pool = sortByScore(filterByPeriod(historyFor(game), period, now))
  const better = pool.filter((e) => e.score > score).length
  return better + 1
}

export function ranksForScore(
  game: GameSlug,
  score: number,
  now = Date.now(),
): Partial<Record<Period, number>> {
  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const rank = rankForScore(game, score, period, now)
    if (rank != null) ranks[period] = rank
  }
  return ranks
}

function pruneHistory(entries: LeaderboardEntry[], now = Date.now()): LeaderboardEntry[] {
  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000
  return sortByScore(entries.filter((e) => e.at >= cutoff)).slice(0, MAX_HISTORY)
}

export function addScore(
  game: GameSlug,
  name: string,
  score: number,
  device: DeviceType = 'desktop',
): {
  board: LeaderboardEntry[]
  entry: LeaderboardEntry
  rank: number | null
  ranks: Partial<Record<Period, number>>
  previousBestRanks: Partial<Record<Period, number>>
  bestRanks: Partial<Record<Period, number>>
} {
  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  const now = Date.now()
  const previousBestRanks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const prior = bestForName(game, cleaned, period, now)
    if (prior) previousBestRanks[period] = prior.rank
  }

  const entry: LeaderboardEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score,
    at: now,
    device: isDeviceType(device) ? device : 'desktop',
  }

  const store = ensureStore()
  const next = pruneHistory([...(store[game] ?? []), entry], now)
  store[game] = next
  writeStore(store)

  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const pool = sortByScore(filterByPeriod(next, period, now))
    const index = pool.findIndex((e) => e.id === entry.id)
    if (index !== -1) ranks[period] = index + 1
  }

  const bestRanks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const best = bestForName(game, cleaned, period, now)
    if (best) bestRanks[period] = best.rank
  }

  const rank = ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null
  return {
    board: getBoard(game, 'daily'),
    entry,
    rank,
    ranks,
    previousBestRanks,
    bestRanks,
  }
}

/** Rename a player across all game boards (history rows keep the new tag). */
export function renamePlayerAcrossLeaderboards(
  fromRaw: string,
  toRaw: string,
): { from: string; to: string; updated: number } {
  const from = fromRaw.trim().slice(0, 12).toUpperCase()
  const to = toRaw.trim().slice(0, 12).toUpperCase()
  if (!from || !to || from === to) return { from, to, updated: 0 }

  const store = ensureStore()
  let updated = 0
  for (const game of ALLOWED_GAMES) {
    for (const entry of store[game] ?? []) {
      if (entry.name === from) {
        entry.name = to
        updated += 1
      }
    }
  }
  if (updated) writeStore(store)
  return { from, to, updated }
}
