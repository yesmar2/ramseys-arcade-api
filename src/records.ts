import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, recordScores } from './db/schema.js'
import {
  ALLOWED_GAMES,
  boardDateKey,
  filterByPeriod,
  isAllowedGame,
  isDeviceType,
  previousBoardDateKey,
  type DeviceType,
  type GameSlug,
  type LeaderboardEntry,
  type NameScope,
  type Period,
} from './store.js'

const MAX_BOARD = 100
const MAX_HISTORY = 500
const ASTEROIDS_WAVE_MAX = 20
const SNAKE_LENGTH_MILESTONE_MIN = 20
const SNAKE_LENGTH_MILESTONE_MAX = 100
const SNAKE_LENGTH_MILESTONE_STEP = 10
const STRIDE_ROW_MILESTONE_MIN = 50
const STRIDE_ROW_MILESTONE_MAX = 200
const STRIDE_ROW_MILESTONE_STEP = 50

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

function buildStrideFastestRowRecords(): RecordDef[] {
  const defs: RecordDef[] = []
  for (
    let rows = STRIDE_ROW_MILESTONE_MIN;
    rows <= STRIDE_ROW_MILESTONE_MAX;
    rows += STRIDE_ROW_MILESTONE_STEP
  ) {
    defs.push({
      id: `fastest-row-${rows}`,
      game: 'stride',
      label: `Fastest to ${rows}`,
      direction: 'lower',
      unit: 'ms',
    })
  }
  return defs
}

const STRIDE_MOST_COINS: RecordDef = {
  id: 'most-coins',
  game: 'stride',
  label: 'Most coins in a run',
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

export const PLAY_DAYS_STREAK_ID = 'play-days-streak'
export const THRESHOLD_STREAK_ID = 'threshold-streak'

/** Minimum consecutive count before it lands on the record book. */
const MIN_CROSS_RUN_STREAK = 2

/**
 * Score a run must meet (or beat) to keep a “strong scores in a row” streak.
 * Spotter uses inverted time (higher board score = faster clear).
 */
export const SCORE_STREAK_THRESHOLDS: Record<GameSlug, number> = {
  asteroids: 1000,
  patriot: 1000,
  snake: 50,
  stride: 40,
  stacker: 15,
  centroid: 6000,
  pop: 300,
  simon: 10,
  crosswalk: 800,
  spotter: 955_000, // ≈ under 45s
  pellets: 2000,
}

function thresholdStreakLabel(game: GameSlug, threshold: number): string {
  if (game === 'spotter') return 'Sub-45s clears in a row'
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
  STRIDE_MOST_COINS,
  POP_CENTER_STREAK,
  STACKER_PERFECT_STREAK,
  ...buildAsteroidsWaveRecords(),
  ...buildSnakeFastestLengthRecords(),
  ...buildStrideFastestRowRecords(),
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

export function isStrideFastestRowRecord(recordId: string): number | null {
  const match = /^fastest-row-(\d+)$/.exec(recordId)
  if (!match) return null
  const rows = Number(match[1])
  if (
    !Number.isInteger(rows) ||
    rows < STRIDE_ROW_MILESTONE_MIN ||
    rows > STRIDE_ROW_MILESTONE_MAX ||
    rows % STRIDE_ROW_MILESTONE_STEP !== 0
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

async function historyFor(game: GameSlug, recordId: string): Promise<RecordEntry[]> {
  const rows = await db()
    .select()
    .from(recordScores)
    .where(and(eq(recordScores.game, game), eq(recordScores.recordId, recordId)))
  return rows.map(rowToEntry)
}

function filterByNames<T extends { name: string }>(entries: T[], scope?: NameScope): T[] {
  if (!scope) return entries
  return entries.filter((e) => scope.has(e.name))
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
  const pool = filterByNames(filterByPeriod(await historyFor(game, recordId), period, now), scope)
  return sortEntries(pool, def.direction).slice(0, MAX_BOARD)
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
  const pool = sortEntries(
    filterByNames(filterByPeriod(await historyFor(game, recordId), period, now), scope),
    def.direction,
  )
  const mine = pool.filter((e) => e.name === cleaned)
  if (!mine.length) return null
  const best = mine[0]
  return { ...best, rank: pool.findIndex((e) => e.id === best.id) + 1 }
}

export async function listGameRecords(
  game: GameSlug,
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<{
  records: Array<RecordDef & { top: RecordEntry | null }>
}> {
  const records = []
  for (const def of listRecordDefs(game)) {
    const board = await getRecordBoard(game, def.id, period, now, scope)
    records.push({ ...def, top: board[0] ?? null })
  }
  return { records }
}

function wouldQualifyForBoard(
  entries: RecordEntry[],
  value: number,
  direction: RecordDirection,
): boolean {
  const sorted = sortEntries(entries, direction)
  if (sorted.length < MAX_BOARD) return true
  return isBetter(value, sorted[MAX_BOARD - 1].score, direction)
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
  const history = await historyFor(game, recordId)
  const mine = history.filter((e) => e.name === cleaned)
  const now = Date.now()
  const improvesPeriod = (period: Period) => {
    const best = sortEntries(filterByPeriod(mine, period, now), def.direction)[0]
    return !best || isBetter(value, best.score, def.direction)
  }
  const qualifiesOnBoard = (period: Period) =>
    wouldQualifyForBoard(
      filterByPeriod(history, period, now),
      value,
      def.direction,
    )
  const accept =
    improvesPeriod('all') ||
    improvesPeriod('daily') ||
    improvesPeriod('weekly') ||
    improvesPeriod('monthly') ||
    qualifiesOnBoard('all') ||
    qualifiesOnBoard('daily') ||
    qualifiesOnBoard('weekly') ||
    qualifiesOnBoard('monthly')
  if (!accept) {
    const board = await getRecordBoard(game, recordId, 'all')
    const you = await bestRecordForName(game, recordId, cleaned, 'all')
    const previousBest = sortEntries(mine, def.direction)[0] ?? null
    return {
      improved: false,
      entry: previousBest,
      rank: you?.rank ?? null,
      ranks: {},
      board,
      totalEntries: history.length,
    }
  }

  const entry: RecordEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleaned,
    score: value,
    at: Date.now(),
    device: isDeviceType(device) ? device : 'desktop',
  }

  await db().transaction(async (tx) => {
    await tx.insert(recordScores).values({
      id: entry.id,
      game,
      recordId,
      name: entry.name,
      score: entry.score,
      at: entry.at,
      device: entry.device,
    })
    // Keep newest MAX_HISTORY rows for this board
    await tx.execute(sql`
      DELETE FROM record_scores AS rs
      WHERE rs.game = ${game}
        AND rs.record_id = ${recordId}
        AND rs.id NOT IN (
          SELECT keep.id FROM (
            SELECT id
            FROM record_scores
            WHERE game = ${game} AND record_id = ${recordId}
            ORDER BY at DESC
            LIMIT ${MAX_HISTORY}
          ) AS keep
        )
    `)
  })

  const next = await historyFor(game, recordId)
  const ranks: Partial<Record<Period, number>> = {}
  for (const period of ['daily', 'weekly', 'monthly', 'all'] as const) {
    const pool = sortEntries(filterByPeriod(next, period), def.direction)
    const index = pool.findIndex((e) => e.id === entry.id)
    if (index !== -1) ranks[period] = index + 1
  }

  return {
    improved: true,
    entry,
    rank: ranks.all ?? ranks.daily ?? null,
    ranks,
    board: await getRecordBoard(game, recordId, 'all'),
    totalEntries: next.length,
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

async function playerRunHistory(
  game: GameSlug,
  name: string,
): Promise<{ score: number; at: number }[]> {
  return db()
    .select({
      score: leaderboardScores.score,
      at: leaderboardScores.at,
    })
    .from(leaderboardScores)
    .where(and(eq(leaderboardScores.game, game), eq(leaderboardScores.name, name)))
    .orderBy(desc(leaderboardScores.at))
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
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_STEP,
  STRIDE_ROW_MILESTONE_MIN,
  STRIDE_ROW_MILESTONE_MAX,
  STRIDE_ROW_MILESTONE_STEP,
}
