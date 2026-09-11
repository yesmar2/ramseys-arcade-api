import { asc, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'

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

const MAX_BOARD = 100
const MAX_HISTORY = 500
const RETAIN_DAYS = 100

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
}

export async function replaceGameBoard(game: GameSlug, entries: LeaderboardEntry[]) {
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

async function historyFor(game: GameSlug): Promise<LeaderboardEntry[]> {
  const rows = await db()
    .select()
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, game))
    .orderBy(desc(leaderboardScores.score), asc(leaderboardScores.at))
  return rows.map(rowToEntry)
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
): Promise<LeaderboardEntry[]> {
  return topBoard(filterByNames(filterByPeriod(await historyFor(game), period, now), scope))
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
  const pool = sortByScore(
    filterByNames(filterByPeriod(await historyFor(game), period, now), scope),
  )
  const mine = pool.filter((e) => e.name === cleaned)
  if (!mine.length) return null
  const best = mine[0]
  return { ...best, rank: pool.findIndex((e) => e.id === best.id) + 1 }
}

export async function bestsForName(name: string): Promise<Partial<Record<GameSlug, number>>> {
  const out: Partial<Record<GameSlug, number>> = {}
  for (const game of ALLOWED_GAMES) {
    const row = await bestForName(game, name, 'all')
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

function placementsFromPool(pool: LeaderboardEntry[]): { name: string; place: number }[] {
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

async function periodPlacements(
  game: GameSlug,
  period: Period,
  now = Date.now(),
  scope?: NameScope,
): Promise<{ name: string; place: number }[]> {
  return placementsFromPool(
    sortByScore(filterByNames(filterByPeriod(await historyFor(game), period, now), scope)),
  )
}

async function closedPeriodPlacements(
  game: GameSlug,
  period: ClosedPeriod,
  periodKey: number,
): Promise<{ name: string; place: number }[]> {
  return placementsFromPool(
    sortByScore(filterByClosedPeriod(await historyFor(game), period, periodKey)),
  )
}

async function aggregateGlobalRanks(
  placementsForGame: (game: GameSlug) => Promise<{ name: string; place: number }[]>,
): Promise<GlobalRankEntry[]> {
  const byName = new Map<
    string,
    { score: number; games: number; byGame: Partial<Record<GameSlug, GlobalGamePlace>> }
  >()

  for (const game of ALLOWED_GAMES) {
    for (const { name, place } of await placementsForGame(game)) {
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

export async function globalRanks(
  period: Period = 'all',
  now = Date.now(),
  scope?: NameScope,
): Promise<GlobalRankEntry[]> {
  return aggregateGlobalRanks((game) => periodPlacements(game, period, now, scope))
}

/** Global ranks for a completed weekly or monthly period. */
export async function globalRanksForClosedPeriod(
  period: ClosedPeriod,
  periodKey: number,
): Promise<GlobalRankEntry[]> {
  return aggregateGlobalRanks((game) => closedPeriodPlacements(game, period, periodKey))
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
  const all = await globalRanks(period, now, scope)
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

export async function qualifies(
  game: GameSlug,
  score: number,
  period: Period = 'daily',
  now = Date.now(),
): Promise<boolean> {
  if (score <= 0) return false
  const board = await getBoard(game, period, now)
  if (board.length < MAX_BOARD) return true
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
  const pool = sortByScore(filterByPeriod(await historyFor(game), period, now))
  const better = pool.filter((e) => e.score > score).length
  return better + 1
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

export async function addScore(
  game: GameSlug,
  name: string,
  score: number,
  device: DeviceType = 'desktop',
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

  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000

  await db().transaction(async (tx) => {
    await tx.insert(leaderboardScores).values({
      id: entry.id,
      game,
      name: entry.name,
      score: entry.score,
      at: entry.at,
      device: entry.device,
    })
    await tx.execute(sql`
      DELETE FROM leaderboard_scores AS ls
      WHERE ls.game = ${game}
        AND (
          ls.at < ${cutoff}
          OR ls.id NOT IN (
            SELECT keep.id FROM (
              SELECT id
              FROM leaderboard_scores
              WHERE game = ${game}
              ORDER BY score DESC, at ASC
              LIMIT ${MAX_HISTORY}
            ) AS keep
          )
        )
    `)
  })

  const next = await historyFor(game)
  const ranks: Partial<Record<Period, number>> = {}
  for (const period of PERIODS) {
    const pool = sortByScore(filterByPeriod(next, period, now))
    const index = pool.findIndex((e) => e.id === entry.id)
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

  const updated = await db()
    .update(leaderboardScores)
    .set({ name: to })
    .where(eq(leaderboardScores.name, from))
    .returning({ id: leaderboardScores.id })
  return { from, to, updated: updated.length }
}
