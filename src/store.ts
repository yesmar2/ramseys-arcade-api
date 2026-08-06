import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'leaderboards.json')

export const ALLOWED_GAMES = ['stacker', 'patriot', 'snake'] as const
export type GameSlug = (typeof ALLOWED_GAMES)[number]

export const PERIODS = ['daily', 'weekly', 'monthly', 'all'] as const
export type Period = (typeof PERIODS)[number]

/** Calendar periods evaluated in this timezone. */
export const BOARD_TZ = 'America/New_York'

export type LeaderboardEntry = {
  id: string
  name: string
  score: number
  at: number
}

type Store = Record<string, LeaderboardEntry[]>

const MAX_BOARD = 10
const MAX_HISTORY = 500
const RETAIN_DAYS = 100

function emptyStore(): Store {
  return { stacker: [], patriot: [], snake: [] }
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
    return {
      stacker: Array.isArray(parsed.stacker) ? parsed.stacker : [],
      patriot: Array.isArray(parsed.patriot) ? parsed.patriot : [],
      snake: Array.isArray(parsed.snake) ? parsed.snake : [],
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(store: Store) {
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, STORE_PATH)
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
  if (!qualifies(game, score, period, now)) return null
  const board = getBoard(game, period, now)
  const index = board.findIndex((e) => score > e.score)
  return index === -1 ? board.length + 1 : index + 1
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
): {
  board: LeaderboardEntry[]
  entry: LeaderboardEntry
  rank: number | null
  ranks: Partial<Record<Period, number>>
} {
  const cleaned = name.trim().slice(0, 12) || 'Player'
  const entry: LeaderboardEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score,
    at: Date.now(),
  }

  const store = ensureStore()
  const next = pruneHistory([...(store[game] ?? []), entry])
  store[game] = next
  writeStore(store)

  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const board = getBoard(game, period)
    const index = board.findIndex((e) => e.id === entry.id)
    if (index !== -1) ranks[period] = index + 1
  }

  const rank = ranks.daily ?? ranks.weekly ?? ranks.monthly ?? ranks.all ?? null
  return {
    board: getBoard(game, 'daily'),
    entry,
    rank,
    ranks,
  }
}
