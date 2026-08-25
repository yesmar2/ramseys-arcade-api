import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  filterByPeriod,
  isAllowedGame,
  isDeviceType,
  type DeviceType,
  type GameSlug,
  type LeaderboardEntry,
  type Period,
} from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'records.json')

const MAX_BOARD = 100
const MAX_HISTORY = 500
const ASTEROIDS_WAVE_MAX = 20
const SNAKE_LENGTH_MILESTONE_MIN = 20
const SNAKE_LENGTH_MILESTONE_MAX = 100
const SNAKE_LENGTH_MILESTONE_STEP = 10

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

const RECORD_DEFS: RecordDef[] = [
  ASTEROIDS_HIGHEST_COMBO,
  ...buildAsteroidsWaveRecords(),
  ...buildSnakeFastestLengthRecords(),
]

const DEFS_BY_KEY = new Map(
  RECORD_DEFS.map((def) => [`${def.game}::${def.id}`, def] as const),
)

export function listRecordDefs(game: GameSlug): RecordDef[] {
  return RECORD_DEFS.filter((def) => def.game === game)
}

export function getRecordDef(game: string, recordId: string): RecordDef | null {
  if (!isAllowedGame(game)) return null
  return DEFS_BY_KEY.get(`${game}::${recordId}`) ?? null
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

function emptyStore(): RecordsStore {
  return {}
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

function ensureStore(): RecordsStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!fs.existsSync(STORE_PATH)) {
    const empty = emptyStore()
    fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2))
    return empty
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as RecordsStore
    const store: RecordsStore = {}
    if (!raw || typeof raw !== 'object') return emptyStore()
    for (const [key, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) continue
      store[key] = rows.map(normalizeEntry).filter((e): e is RecordEntry => e != null)
    }
    return store
  } catch {
    return emptyStore()
  }
}

function writeStore(store: RecordsStore) {
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, STORE_PATH)
}

export function replaceAllRecords(next: RecordsStore) {
  const cleaned: RecordsStore = {}
  for (const [key, rows] of Object.entries(next ?? {})) {
    if (!Array.isArray(rows)) continue
    cleaned[key] = rows
      .map(normalizeEntry)
      .filter((e): e is RecordEntry => e != null)
  }
  writeStore(cleaned)
}

export function isRecordsStoreEmpty() {
  const store = ensureStore()
  return Object.values(store).every((rows) => !rows?.length)
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

function historyFor(game: GameSlug, recordId: string): RecordEntry[] {
  return ensureStore()[boardKey(game, recordId)] ?? []
}

function pruneHistory(entries: RecordEntry[]): RecordEntry[] {
  if (entries.length <= MAX_HISTORY) return entries
  return entries.slice(entries.length - MAX_HISTORY)
}

export function getRecordBoard(
  game: GameSlug,
  recordId: string,
  period: Period = 'all',
  now = Date.now(),
): RecordEntry[] {
  const def = getRecordDef(game, recordId)
  if (!def) return []
  const pool = filterByPeriod(historyFor(game, recordId), period, now)
  return sortEntries(pool, def.direction).slice(0, MAX_BOARD)
}

export function bestRecordForName(
  game: GameSlug,
  recordId: string,
  name: string,
  period: Period = 'all',
  now = Date.now(),
): YouRecordEntry | null {
  const def = getRecordDef(game, recordId)
  if (!def) return null
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return null
  const pool = sortEntries(
    filterByPeriod(historyFor(game, recordId), period, now),
    def.direction,
  )
  const mine = pool.filter((e) => e.name === cleaned)
  if (!mine.length) return null
  const best = mine[0]
  return { ...best, rank: pool.findIndex((e) => e.id === best.id) + 1 }
}

export function listGameRecords(game: GameSlug): {
  records: Array<RecordDef & { top: RecordEntry | null }>
} {
  const records = listRecordDefs(game).map((def) => {
    const board = getRecordBoard(game, def.id, 'all')
    return { ...def, top: board[0] ?? null }
  })
  return { records }
}

export function addRecord(
  game: GameSlug,
  recordId: string,
  name: string,
  score: number,
  device: DeviceType = 'desktop',
): {
  improved: boolean
  entry: RecordEntry | null
  rank: number | null
  ranks: Partial<Record<Period, number>>
  board: RecordEntry[]
} {
  const def = getRecordDef(game, recordId)
  if (!def) {
    throw Object.assign(new Error('Unknown record'), { status: 404 })
  }
  if (!Number.isFinite(score) || score < 0) {
    throw Object.assign(new Error('Invalid score'), { status: 400 })
  }
  const value = Math.floor(score)
  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  const key = boardKey(game, recordId)
  const store = ensureStore()
  const history = [...(store[key] ?? [])]
  const previousBest = sortEntries(
    history.filter((e) => e.name === cleaned),
    def.direction,
  )[0]

  if (previousBest && !isBetter(value, previousBest.score, def.direction)) {
    const board = getRecordBoard(game, recordId, 'all')
    const you = bestRecordForName(game, recordId, cleaned, 'all')
    return {
      improved: false,
      entry: previousBest,
      rank: you?.rank ?? null,
      ranks: {},
      board,
    }
  }

  const entry: RecordEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score: value,
    at: Date.now(),
    device: isDeviceType(device) ? device : 'desktop',
  }
  store[key] = pruneHistory([...history, entry])
  writeStore(store)

  const ranks: Partial<Record<Period, number>> = {}
  for (const period of ['daily', 'weekly', 'monthly', 'all'] as const) {
    const pool = sortEntries(
      filterByPeriod(store[key], period),
      def.direction,
    )
    const index = pool.findIndex((e) => e.id === entry.id)
    if (index !== -1) ranks[period] = index + 1
  }

  return {
    improved: true,
    entry,
    rank: ranks.all ?? ranks.daily ?? null,
    ranks,
    board: getRecordBoard(game, recordId, 'all'),
  }
}

export function renamePlayerAcrossRecords(
  fromRaw: string,
  toRaw: string,
): { from: string; to: string; updated: number } {
  const from = fromRaw.trim().slice(0, 12).toUpperCase()
  const to = toRaw.trim().slice(0, 12).toUpperCase()
  if (!from || !to || from === to) return { from, to, updated: 0 }

  const store = ensureStore()
  let updated = 0
  for (const entries of Object.values(store)) {
    for (const entry of entries) {
      if (entry.name === from) {
        entry.name = to
        updated += 1
      }
    }
  }
  if (updated) writeStore(store)
  return { from, to, updated }
}

export {
  ASTEROIDS_WAVE_MAX,
  ASTEROIDS_HIGHEST_COMBO,
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_STEP,
}
