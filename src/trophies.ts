import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_GAMES,
  getClosedBoard,
  loadStore,
  monthKey,
  weekStartKey,
  type GameSlug,
} from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const TROPHIES_PATH = path.join(DATA_DIR, 'trophies.json')
const CLAIMS_PATH = path.join(DATA_DIR, 'name-claims.json')

export type TrophyPeriod = 'weekly' | 'monthly'

export type TrophyAward = {
  id: string
  game: GameSlug
  period: TrophyPeriod
  periodKey: number
  name: string
  accountId?: string
  score: number
  entryId: string
  awardedAt: number
}

type TrophiesStore = {
  awards: TrophyAward[]
  cursor: {
    weeklyInitialized?: boolean
    monthlyInitialized?: boolean
  }
}

function awardId(game: GameSlug, period: TrophyPeriod, periodKey: number) {
  return `${game}-${period}-${periodKey}`
}

function emptyStore(): TrophiesStore {
  return { awards: [], cursor: {} }
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
    return { awards: parsed.awards, cursor: parsed.cursor ?? {} }
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

function hasAward(store: TrophiesStore, game: GameSlug, period: TrophyPeriod, periodKey: number) {
  return store.awards.some((a) => a.id === awardId(game, period, periodKey))
}

function tryAward(
  store: TrophiesStore,
  game: GameSlug,
  period: TrophyPeriod,
  periodKey: number,
  now: number,
): boolean {
  if (hasAward(store, game, period, periodKey)) return false
  const winner = getClosedBoard(game, period, periodKey)[0]
  if (!winner) return false
  store.awards.push({
    id: awardId(game, period, periodKey),
    game,
    period,
    periodKey,
    name: winner.name,
    accountId: lookupAccountId(winner.name),
    score: winner.score,
    entryId: winner.id,
    awardedAt: now,
  })
  return true
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

/** Award weekly/monthly #1 trophies for completed periods (lazy rollover). */
export function ensurePeriodTrophies(now = Date.now()) {
  loadStore()
  const store = ensureTrophiesStore()
  let changed = false

  const weekCount = store.cursor.weeklyInitialized ? 1 : 8
  const monthCount = store.cursor.monthlyInitialized ? 1 : 6

  for (const weekKey of listWeekKeysBefore(now, weekCount)) {
    for (const game of ALLOWED_GAMES) {
      if (tryAward(store, game, 'weekly', weekKey, now)) changed = true
    }
  }

  for (const monthKeyVal of listMonthKeysBefore(now, monthCount)) {
    for (const game of ALLOWED_GAMES) {
      if (tryAward(store, game, 'monthly', monthKeyVal, now)) changed = true
    }
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
}

export function trophiesForName(name: string): TrophyAward[] {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return []
  return ensureTrophiesStore()
    .awards.filter((a) => a.name === cleaned)
    .sort((a, b) => b.awardedAt - a.awardedAt)
}

export function recentTrophies(limit = 20): TrophyAward[] {
  const capped = Math.min(50, Math.max(1, Math.floor(limit)) || 20)
  return [...ensureTrophiesStore().awards]
    .sort((a, b) => b.awardedAt - a.awardedAt)
    .slice(0, capped)
}

export function renamePlayerAcrossTrophies(from: string, to: string) {
  const store = ensureTrophiesStore()
  let updated = 0
  for (const award of store.awards) {
    if (award.name === from) {
      award.name = to
      updated++
    }
  }
  if (updated) writeTrophiesStore(store)
  return updated
}
