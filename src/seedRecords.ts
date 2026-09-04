import {
  ASTEROIDS_WAVE_MAX,
  isRecordsStoreEmpty,
  listRecordDefs,
  replaceAllRecords,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_STEP,
  STRIDE_ROW_MILESTONE_MAX,
  STRIDE_ROW_MILESTONE_MIN,
  STRIDE_ROW_MILESTONE_STEP,
  type RecordEntry,
} from './records.js'
import { SEED_NAMES } from './seedBoards.js'
import type { DeviceType, GameSlug } from './store.js'

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const DEVICES: DeviceType[] = ['phone', 'tablet', 'desktop']
const RECORD_GAMES: GameSlug[] = ['asteroids', 'snake', 'patriot', 'stride', 'pop']

function stamp(daysAgo: number, rand: () => number) {
  const hour = 9 + Math.floor(rand() * 12)
  const minute = Math.floor(rand() * 60)
  return (
    Date.now() -
    daysAgo * 86_400_000 -
    hour * 3600_000 -
    minute * 60_000 -
    Math.floor(rand() * 50_000)
  )
}

function entry(
  name: string,
  score: number,
  at: number,
  device: DeviceType,
): RecordEntry {
  const tag = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  return {
    id: `${at}-${tag}${score}`,
    name,
    score,
    at,
    device,
  }
}

function waveTimeMs(wave: number, skill: number, rand: () => number) {
  const baseSec = 28 + wave * 9 + wave * wave * 0.55
  const slack = 1.02 + (1 - skill) * 0.38 + rand() * 0.18
  return Math.round(baseSec * 1000 * slack)
}

function lengthTimeMs(length: number, skill: number, rand: () => number) {
  const foods = Math.max(1, length - 3)
  const secPerFood = 1.85 - skill * 0.65 + rand() * 0.45
  return Math.max(6_500, Math.round(foods * secPerFood * 1000))
}

function strideRowTimeMs(rows: number, skill: number, rand: () => number) {
  const secPerRow = 0.95 - skill * 0.35 + rand() * 0.28
  return Math.max(8_000, Math.round(rows * secPerRow * 1000))
}

function comboValue(skill: number, rand: () => number) {
  const raw = 3 + skill * 8 + rand() * 5
  return Math.max(2, Math.min(18, Math.round(raw)))
}

function directStreakValue(skill: number, rand: () => number) {
  const raw = 3 + skill * 7 + rand() * 4
  return Math.max(2, Math.min(16, Math.round(raw)))
}

function coinsValue(skill: number, rand: () => number) {
  const raw = 4 + skill * 28 + rand() * 12
  return Math.max(2, Math.min(48, Math.round(raw)))
}

function centerStreakValue(skill: number, rand: () => number) {
  const raw = 2 + skill * 9 + rand() * 4
  return Math.max(2, Math.min(18, Math.round(raw)))
}

export function buildRecordsSeed(seed = 20260904) {
  const rand = mulberry32(seed ^ 0x9e3779b9)
  const store: Record<string, RecordEntry[]> = {}

  const players = SEED_NAMES.map((name, i) => {
    const rankT = i / Math.max(1, SEED_NAMES.length - 1)
    const skill = Math.pow(1 - rankT, 0.7) * (0.5 + rand() * 0.5)
    const device = DEVICES[Math.floor(rand() * DEVICES.length)]
    return { name, skill, device, i }
  })

  store['asteroids::highest-combo'] = players
    .filter((p) => p.skill > 0.12 || rand() < 0.4)
    .slice(0, 18)
    .map((p) =>
      entry(
        p.name,
        comboValue(p.skill, rand),
        stamp(Math.floor(rand() * 40), rand),
        p.device,
      ),
    )

  store['patriot::direct-streak'] = players
    .filter((p) => p.skill > 0.1 || rand() < 0.4)
    .slice(0, 16)
    .map((p) =>
      entry(
        p.name,
        directStreakValue(p.skill, rand),
        stamp(Math.floor(rand() * 40), rand),
        p.device,
      ),
    )

  store['stride::most-coins'] = players
    .filter((p) => p.skill > 0.08 || rand() < 0.45)
    .slice(0, 20)
    .map((p) =>
      entry(
        p.name,
        coinsValue(p.skill, rand),
        stamp(Math.floor(rand() * 35), rand),
        p.device,
      ),
    )

  store['pop::center-streak'] = players
    .filter((p) => p.skill > 0.1 || rand() < 0.42)
    .slice(0, 18)
    .map((p) =>
      entry(
        p.name,
        centerStreakValue(p.skill, rand),
        stamp(Math.floor(rand() * 35), rand),
        p.device,
      ),
    )

  for (let wave = 1; wave <= ASTEROIDS_WAVE_MAX; wave++) {
    const key = `asteroids::wave-time-${wave}`
    const depthNeed = wave / ASTEROIDS_WAVE_MAX
    const pool = players.filter((p) => p.skill >= depthNeed * 0.32 - 0.08)
    const count = Math.max(5, Math.min(16, Math.round(12 - wave * 0.18 + rand() * 3)))
    store[key] = pool.slice(0, count).map((p) =>
      entry(
        p.name,
        waveTimeMs(wave, p.skill, rand),
        stamp(Math.floor(rand() * (20 + wave)), rand),
        p.device,
      ),
    )
  }

  for (
    let length = SNAKE_LENGTH_MILESTONE_MIN;
    length <= SNAKE_LENGTH_MILESTONE_MAX;
    length += SNAKE_LENGTH_MILESTONE_STEP
  ) {
    const key = `snake::fastest-length-${length}`
    const need = length / SNAKE_LENGTH_MILESTONE_MAX
    const pool = players.filter((p) => p.skill >= need * 0.32)
    const count = Math.max(5, Math.min(14, Math.round(11 - length * 0.035 + rand() * 2)))
    store[key] = pool.slice(0, count).map((p) =>
      entry(
        p.name,
        lengthTimeMs(length, p.skill, rand),
        stamp(Math.floor(rand() * 35), rand),
        p.device,
      ),
    )
  }

  for (
    let rows = STRIDE_ROW_MILESTONE_MIN;
    rows <= STRIDE_ROW_MILESTONE_MAX;
    rows += STRIDE_ROW_MILESTONE_STEP
  ) {
    const key = `stride::fastest-row-${rows}`
    const need = rows / STRIDE_ROW_MILESTONE_MAX
    const pool = players.filter((p) => p.skill >= need * 0.28)
    const count = Math.max(5, Math.min(16, Math.round(12 - rows * 0.02 + rand() * 3)))
    store[key] = pool.slice(0, count).map((p) =>
      entry(
        p.name,
        strideRowTimeMs(rows, p.skill, rand),
        stamp(Math.floor(rand() * 30), rand),
        p.device,
      ),
    )
  }

  const allowed = new Set(
    RECORD_GAMES.flatMap((game) => listRecordDefs(game).map((d) => `${d.game}::${d.id}`)),
  )
  for (const key of Object.keys(store)) {
    if (!allowed.has(key)) delete store[key]
  }

  return store
}

export function seedRecords(force = false) {
  if (!force && !isRecordsStoreEmpty()) return false
  replaceAllRecords(buildRecordsSeed())
  return true
}
