import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  globalRanksForClosedPeriod,
  loadStore,
  monthKey,
  weekStartKey,
} from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const TROPHIES_PATH = path.join(DATA_DIR, 'trophies.json')
const CLAIMS_PATH = path.join(DATA_DIR, 'name-claims.json')

export type TrophyPeriod = 'weekly' | 'monthly'
export const MAX_TROPHY_RANK = 10

export type TrophyAward = {
  id: string
  period: TrophyPeriod
  periodKey: number
  name: string
  rank: number
  score: number
  games: number
  accountId?: string
  awardedAt: number
}

type TrophiesStore = {
  awards: TrophyAward[]
  cursor: {
    weeklyInitialized?: boolean
    monthlyInitialized?: boolean
  }
}

function awardId(period: TrophyPeriod, periodKey: number, name: string) {
  return `${period}-${periodKey}-${name}`
}

function emptyStore(): TrophiesStore {
  return { awards: [], cursor: {} }
}

function isTrophyAward(raw: unknown): raw is TrophyAward {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Partial<TrophyAward>
  return (
    typeof row.id === 'string' &&
    (row.period === 'weekly' || row.period === 'monthly') &&
    typeof row.periodKey === 'number' &&
    typeof row.name === 'string' &&
    typeof row.rank === 'number' &&
    typeof row.score === 'number' &&
    typeof row.games === 'number' &&
    typeof row.awardedAt === 'number'
  )
}

function ensureTrophiesStore(): TrophiesStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!fs.existsSync(TROPHIES_PATH)) {
    const empty = emptyStore()
    fs.writeFileSync(TROPHIES_PATH, JSON.stringify(empty, null, 2))
    return empty
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(TROPHIES_PATH, 'utf8')) as TrophiesStore
    if (!parsed || !Array.isArray(parsed.awards)) return emptyStore()
    const awards = parsed.awards.filter(isTrophyAward)
    const migrated = awards.length !== parsed.awards.length
    return {
      awards,
      cursor: migrated
        ? {}
        : (parsed.cursor ?? {}),
    }
  } catch {
    return emptyStore()
  }
}

function writeTrophiesStore(store: TrophiesStore) {
  const tmp = `${TROPHIES_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, TROPHIES_PATH)
}

function lookupAccountId(name: string): string | undefined {
  try {
    if (!fs.existsSync(CLAIMS_PATH)) return undefined
    const parsed = JSON.parse(fs.readFileSync(CLAIMS_PATH, 'utf8')) as {
      claims?: Record<string, { accountId?: string }>
    }
    return parsed.claims?.[name]?.accountId
  } catch {
    return undefined
  }
}

function awardClosedPeriod(
  store: TrophiesStore,
  period: TrophyPeriod,
  periodKey: number,
  now: number,
): boolean {
  const ranked = globalRanksForClosedPeriod(period, periodKey).slice(0, MAX_TROPHY_RANK)
  if (ranked.length === 0) return false
  let changed = false
  for (const row of ranked) {
    const id = awardId(period, periodKey, row.name)
    if (store.awards.some((a) => a.id === id)) continue
    store.awards.push({
      id,
      period,
      periodKey,
      name: row.name,
      rank: row.rank,
      score: row.score,
      games: row.games,
      accountId: lookupAccountId(row.name),
      awardedAt: now,
    })
    changed = true
  }
  return changed
}

function addDaysToDateKey(key: number, days: number) {
  const y = Math.floor(key / 10_000)
  const m = Math.floor((key % 10_000) / 100)
  const d = key % 100
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return y * 10_000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate()
}

function previousWeekStart(now: number) {
  return addDaysToDateKey(weekStartKey(now), -7)
}

function previousMonthKey(now: number) {
  const mk = monthKey(now)
  const y = Math.floor(mk / 100)
  const m = mk % 100
  if (m === 1) return (y - 1) * 100 + 12
  return y * 100 + (m - 1)
}

function listWeekKeysBefore(now: number, count: number) {
  const keys: number[] = []
  let key = previousWeekStart(now)
  for (let i = 0; i < count; i++) {
    keys.push(key)
    key = addDaysToDateKey(key, -7)
  }
  return keys
}

function listMonthKeysBefore(now: number, count: number) {
  const keys: number[] = []
  let key = previousMonthKey(now)
  for (let i = 0; i < count; i++) {
    keys.push(key)
    const y = Math.floor(key / 100)
    const m = key % 100
    if (m === 1) key = (y - 1) * 100 + 12
    else key = y * 100 + (m - 1)
  }
  return keys
}

/** Award global-rank trophies for completed weekly/monthly periods (lazy rollover). */
export function ensurePeriodTrophies(now = Date.now()) {
  loadStore()
  const store = ensureTrophiesStore()
  let changed = false

  const weekCount = store.cursor.weeklyInitialized ? 1 : 8
  const monthCount = store.cursor.monthlyInitialized ? 1 : 6

  for (const weekKey of listWeekKeysBefore(now, weekCount)) {
    if (awardClosedPeriod(store, 'weekly', weekKey, now)) changed = true
  }

  for (const monthKeyVal of listMonthKeysBefore(now, monthCount)) {
    if (awardClosedPeriod(store, 'monthly', monthKeyVal, now)) changed = true
  }

  if (!store.cursor.weeklyInitialized) {
    store.cursor.weeklyInitialized = true
    changed = true
  }
  if (!store.cursor.monthlyInitialized) {
    store.cursor.monthlyInitialized = true
    changed = true
  }

  if (changed) writeTrophiesStore(store)
  ensureShowcaseTrophies()
}

export function trophiesForName(name: string): TrophyAward[] {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return []
  return ensureTrophiesStore()
    .awards.filter((a) => a.name === cleaned)
    .sort((a, b) => b.awardedAt - a.awardedAt || a.rank - b.rank)
}

export function recentTrophies(limit = 20): TrophyAward[] {
  const capped = Math.min(50, Math.max(1, Math.floor(limit)) || 20)
  return [...ensureTrophiesStore().awards]
    .sort((a, b) => b.awardedAt - a.awardedAt || a.rank - b.rank)
    .slice(0, capped)
}

export function renamePlayerAcrossTrophies(from: string, to: string) {
  const store = ensureTrophiesStore()
  let updated = 0
  for (const award of store.awards) {
    if (award.name === from) {
      award.name = to
      award.id = awardId(award.period, award.periodKey, to)
      updated++
    }
  }
  if (updated) writeTrophiesStore(store)
  return updated
}

export type TrophySummary = {
  total: number
  podium: number
  topTen: number
}

export type TrophyCount = Pick<TrophySummary, 'total' | 'podium'>

function summarizeAwards(awards: TrophyAward[]): TrophySummary {
  let podium = 0
  let topTen = 0
  for (const award of awards) {
    if (award.rank <= 3) podium++
    else topTen++
  }
  return { total: awards.length, podium, topTen }
}

export function trophySummaryForName(name: string): TrophySummary {
  return summarizeAwards(trophiesForName(name))
}

export function trophySummariesForNames(names: string[]): Record<string, TrophyCount> {
  const wanted = new Set(
    names.map((n) => n.trim().slice(0, 12).toUpperCase()).filter(Boolean),
  )
  const out: Record<string, TrophyCount> = {}
  for (const award of ensureTrophiesStore().awards) {
    if (!wanted.has(award.name)) continue
    const row = out[award.name] ?? { total: 0, podium: 0 }
    row.total++
    if (award.rank <= 3) row.podium++
    out[award.name] = row
  }
  return out
}

/** Curated showcase awards so demo profiles show every trophy art variant. */
type ShowcaseAward = Omit<TrophyAward, 'id' | 'accountId' | 'name'> & { name: string }

const SHOWCASE_AWARDS: ShowcaseAward[] = [
  // JEFF — full mix of weekly/monthly podium + honor ribbons
  {
    period: 'weekly',
    periodKey: 20260825,
    name: 'JEFF',
    rank: 1,
    score: 842,
    games: 7,
    awardedAt: Date.UTC(2026, 7, 31, 12, 0, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260818,
    name: 'JEFF',
    rank: 2,
    score: 791,
    games: 6,
    awardedAt: Date.UTC(2026, 7, 24, 12, 0, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260811,
    name: 'JEFF',
    rank: 7,
    score: 612,
    games: 5,
    awardedAt: Date.UTC(2026, 7, 17, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202608,
    name: 'JEFF',
    rank: 1,
    score: 2140,
    games: 8,
    awardedAt: Date.UTC(2026, 8, 1, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202607,
    name: 'JEFF',
    rank: 3,
    score: 1884,
    games: 8,
    awardedAt: Date.UTC(2026, 7, 1, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202606,
    name: 'JEFF',
    rank: 8,
    score: 1340,
    games: 6,
    awardedAt: Date.UTC(2026, 6, 1, 12, 0, 0),
  },
  // MOBILE — weekly medal set + a monthly cup
  {
    period: 'weekly',
    periodKey: 20260825,
    name: 'MOBILE',
    rank: 1,
    score: 910,
    games: 8,
    awardedAt: Date.UTC(2026, 7, 31, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260818,
    name: 'MOBILE',
    rank: 3,
    score: 744,
    games: 6,
    awardedAt: Date.UTC(2026, 7, 24, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260811,
    name: 'MOBILE',
    rank: 2,
    score: 802,
    games: 7,
    awardedAt: Date.UTC(2026, 7, 17, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260804,
    name: 'MOBILE',
    rank: 5,
    score: 680,
    games: 5,
    awardedAt: Date.UTC(2026, 7, 10, 12, 5, 0),
  },
  {
    period: 'monthly',
    periodKey: 202608,
    name: 'MOBILE',
    rank: 2,
    score: 2010,
    games: 8,
    awardedAt: Date.UTC(2026, 8, 1, 12, 5, 0),
  },
]

/** Idempotent: fills showcase profiles with weekly/monthly podium + honor ribbons. */
export function ensureShowcaseTrophies() {
  const store = ensureTrophiesStore()
  let changed = false
  for (const row of SHOWCASE_AWARDS) {
    const id = awardId(row.period, row.periodKey, row.name)
    if (store.awards.some((a) => a.id === id)) continue
    const accountId = lookupAccountId(row.name)
    store.awards.push({
      ...row,
      id,
      ...(accountId ? { accountId } : {}),
    })
    changed = true
  }
  if (changed) writeTrophiesStore(store)
  return changed
}
