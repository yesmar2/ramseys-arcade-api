import fs from 'node:fs'

const p = new URL('../src/store.ts', import.meta.url)
let s = fs.readFileSync(p, 'utf8')

const header = `import { and, desc, eq, lt, notInArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'

export const ALLOWED_GAMES = [
  'asteroids',
  'patriot',
  'snake',
  'stride',
  'stacker',
  'centroid',
  'pop',
  'simon',
  'crosswalk',
  'spotter',
  'pellets',
] as const
export type GameSlug = (typeof ALLOWED_GAMES)[number]

/** Legacy API / board keys → current slug. */
const GAME_SLUG_ALIASES: Record<string, string> = {
  'dead-center': 'centroid',
  whack: 'pop',
  'whack-a-mole': 'pop',
}

export function canonicalizeGameSlug(game: string): string {
  return GAME_SLUG_ALIASES[game] ?? game
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
    stride: [],
    pellets: [],
  }
}

function rowToEntry(row: typeof leaderboardScores.$inferSelect): LeaderboardEntry {
  return {
    id: row.id,
    name: row.name,
    score: row.score,
    at: row.at,
    device: isDeviceType(row.device) ? row.device : 'desktop',
  }
}

async function historyFor(game: GameSlug): Promise<LeaderboardEntry[]> {
  const rows = await db()
    .select()
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, game))
    .orderBy(desc(leaderboardScores.score), leaderboardScores.at)
  return rows.map(rowToEntry)
}

export async function loadStore(): Promise<Store> {
  const store = emptyStore()
  const rows = await db().select().from(leaderboardScores)
  for (const row of rows) {
    if (!(ALLOWED_GAMES as readonly string[]).includes(row.game)) continue
    store[row.game as GameSlug].push(rowToEntry(row))
  }
  for (const game of ALLOWED_GAMES) {
    store[game] = sortByScore(store[game])
  }
  return store
}

export async function replaceAllBoards(next: Store) {
  await db().transaction(async (tx) => {
    await tx.delete(leaderboardScores)
    const rows: (typeof leaderboardScores.$inferInsert)[] = []
    for (const game of ALLOWED_GAMES) {
      for (const entry of next[game] ?? []) {
        rows.push({
          id: entry.id,
          game,
          name: entry.name,
          score: entry.score,
          at: entry.at,
          device: isDeviceType(entry.device) ? entry.device : 'desktop',
        })
      }
    }
    if (rows.length) {
      for (let i = 0; i < rows.length; i += 200) {
        await tx.insert(leaderboardScores).values(rows.slice(i, i + 200))
      }
    }
  })
}

export async function replaceGameBoard(game: GameSlug, entries: LeaderboardEntry[]) {
  await db().transaction(async (tx) => {
    await tx.delete(leaderboardScores).where(eq(leaderboardScores.game, game))
    const list = Array.isArray(entries) ? entries : []
    if (!list.length) return
    await tx.insert(leaderboardScores).values(
      list.map((entry) => ({
        id: entry.id,
        game,
        name: entry.name,
        score: entry.score,
        at: entry.at,
        device: isDeviceType(entry.device) ? entry.device : 'desktop',
      })),
    )
  })
}

async function pruneGameHistory(
  tx: {
    delete: typeof db extends () => infer D ? D['delete'] : never
    select: typeof db extends () => infer D ? D['select'] : never
  },
  game: GameSlug,
  now: number,
) {
  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000
  await tx.delete(leaderboardScores).where(and(eq(leaderboardScores.game, game), lt(leaderboardScores.at, cutoff)))
  const keep = await tx
    .select({ id: leaderboardScores.id })
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, game))
    .orderBy(desc(leaderboardScores.score), leaderboardScores.at)
    .limit(MAX_HISTORY)
  const keepIds = keep.map((r) => r.id)
  if (keepIds.length === 0) {
    await tx.delete(leaderboardScores).where(eq(leaderboardScores.game, game))
    return
  }
  await tx
    .delete(leaderboardScores)
    .where(and(eq(leaderboardScores.game, game), notInArray(leaderboardScores.id, keepIds)))
}

`

const sortIdx = s.indexOf('function sortByScore')
if (sortIdx < 0) throw new Error('sortByScore not found')
let rest = s.slice(sortIdx)

rest = rest.replace(/function historyFor\(game: GameSlug\): LeaderboardEntry\[] \{[\s\S]*?\}\n\n/, '')
rest = rest.replace(/export function getClosedBoard/g, 'export async function getClosedBoard')
rest = rest.replace(
  /return topBoard\(filterByClosedPeriod\(historyFor\(game\), period, periodKey\)\)/g,
  'return topBoard(filterByClosedPeriod(await historyFor(game), period, periodKey))',
)
rest = rest.replace(/export function getBoard/g, 'export async function getBoard')
rest = rest.replace(
  /return topBoard\(filterByNames\(filterByPeriod\(historyFor\(game\), period, now\), scope\)\)/g,
  'return topBoard(filterByNames(filterByPeriod(await historyFor(game), period, now), scope))',
)
rest = rest.replace(/export function boardsSummaryForPeriod/g, 'export async function boardsSummaryForPeriod')
rest = rest.replace(
  /out\[game\] = getBoard\(game, period, now, scope\)\.slice\(0, capped\)/g,
  'out[game] = (await getBoard(game, period, now, scope)).slice(0, capped)',
)
rest = rest.replace(/export function boardsSummary/g, 'export async function boardsSummary')
rest = rest.replace(
  /byPeriod\[period\] = getBoard\(game, period, now\)\.slice\(0, capped\)/g,
  'byPeriod[period] = (await getBoard(game, period, now)).slice(0, capped)',
)
rest = rest.replace(/export function bestForName/g, 'export async function bestForName')
rest = rest.replace(
  /const pool = sortByScore\(filterByNames\(filterByPeriod\(historyFor\(game\), period, now\), scope\)\)/g,
  'const pool = sortByScore(filterByNames(filterByPeriod(await historyFor(game), period, now), scope))',
)
rest = rest.replace(/export function bestsForName/g, 'export async function bestsForName')
rest = rest.replace(
  /const row = bestForName\(game, name, 'all'\)/g,
  "const row = await bestForName(game, name, 'all')",
)
rest = rest.replace(/function periodPlacements/g, 'async function periodPlacements')
rest = rest.replace(
  /return placementsFromPool\(\s*sortByScore\(filterByNames\(filterByPeriod\(historyFor\(game\), period, now\), scope\)\),\s*\)/g,
  'return placementsFromPool(sortByScore(filterByNames(filterByPeriod(await historyFor(game), period, now), scope)))',
)
rest = rest.replace(/function closedPeriodPlacements/g, 'async function closedPeriodPlacements')
rest = rest.replace(
  /return placementsFromPool\(\s*sortByScore\(filterByClosedPeriod\(historyFor\(game\), period, periodKey\)\),\s*\)/g,
  'return placementsFromPool(sortByScore(filterByClosedPeriod(await historyFor(game), period, periodKey)))',
)
rest = rest.replace(
  /function aggregateGlobalRanks\(\s*placementsForGame: \(game: GameSlug\) => \{ name: string; place: number \}\[],\s*\)/g,
  'async function aggregateGlobalRanks(\n  placementsForGame: (game: GameSlug) => Promise<{ name: string; place: number }[]>,\n)',
)
rest = rest.replace(
  /for \(const \{ name, place \} of placementsForGame\(game\)\)/g,
  'for (const { name, place } of await placementsForGame(game))',
)
rest = rest.replace(/export function globalRanks/g, 'export async function globalRanks')
rest = rest.replace(/export function globalRanksForClosedPeriod/g, 'export async function globalRanksForClosedPeriod')
rest = rest.replace(/export function rankForName/g, 'export async function rankForName')
rest = rest.replace(/const all = globalRanks\(period, now, scope\)/g, 'const all = await globalRanks(period, now, scope)')
rest = rest.replace(/export function qualifies\(/g, 'export async function qualifies(')
rest = rest.replace(/const board = getBoard\(game, period, now\)/g, 'const board = await getBoard(game, period, now)')
rest = rest.replace(/export function qualifiesAny/g, 'export async function qualifiesAny')
rest = rest.replace(
  /return PERIODS\.some\(\(period\) => qualifies\(game, score, period, now\)\)/g,
  `for (const period of PERIODS) {
    if (await qualifies(game, score, period, now)) return true
  }
  return false`,
)
rest = rest.replace(/export function rankForScore/g, 'export async function rankForScore')
rest = rest.replace(
  /const pool = sortByScore\(filterByPeriod\(historyFor\(game\), period, now\)\)/g,
  'const pool = sortByScore(filterByPeriod(await historyFor(game), period, now))',
)
rest = rest.replace(/export function ranksForScore/g, 'export async function ranksForScore')
rest = rest.replace(
  /const rank = rankForScore\(game, score, period, now\)/g,
  'const rank = await rankForScore(game, score, period, now)',
)

const pruneIdx = rest.indexOf('function pruneHistory')
if (pruneIdx < 0) throw new Error('pruneHistory not found')
rest = rest.slice(0, pruneIdx)

rest += `
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
    id: \`\${now}-\${Math.random().toString(36).slice(2, 8)}\`,
    name: cleaned,
    score,
    at: now,
    device: isDeviceType(device) ? device : 'desktop',
  }

  await db().transaction(async (tx) => {
    await tx.insert(leaderboardScores).values({
      id: entry.id,
      game,
      name: entry.name,
      score: entry.score,
      at: entry.at,
      device: entry.device,
    })
    await pruneGameHistory(tx as never, game, now)
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

  const result = await db()
    .update(leaderboardScores)
    .set({ name: to })
    .where(eq(leaderboardScores.name, from))
  const updated = Number((result as { rowCount?: number; count?: number }).rowCount ?? result.count ?? 0)
  return { from, to, updated }
}
`

fs.writeFileSync(p, header + '\n' + rest)
console.log('ok', fs.statSync(p).size)
