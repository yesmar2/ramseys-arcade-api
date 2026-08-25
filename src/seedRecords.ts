import {
  ASTEROIDS_WAVE_MAX,
  isRecordsStoreEmpty,
  listRecordDefs,
  replaceAllRecords,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_STEP,
  type RecordEntry,
} from './records.js'
import { SEED_NAMES } from './seedBoards.js'
import type { DeviceType } from './store.js'

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

/** Wave clear times in ms — early waves quick, later waves slower. */
function waveTimeMs(wave: number, skill: number, rand: () => number) {
  const base = 14_000 + wave * 9_500 + wave * wave * 420
  const elite = 0.55 + skill * 0.35
  const jitter = 0.88 + rand() * 0.28
  return Math.max(8_000, Math.round(base * (1.55 - elite) * jitter))
}

/** Fastest-to-length times in ms. */
function lengthTimeMs(length: number, skill: number, rand: () => number) {
  const foods = Math.max(1, length - 3)
  const secPerFood = 1.15 - skill * 0.45 + rand() * 0.35
  return Math.max(4_000, Math.round(foods * secPerFood * 1000))
}

function comboValue(skill: number, rand: () => number) {
  const raw = 2 + Math.pow(skill, 1.1) * 36 * (0.75 + rand() * 0.5)
  return Math.max(2, Math.min(48, Math.round(raw)))
}

function directStreakValue(skill: number, rand: () => number) {
  const raw = 2 + Math.pow(skill, 1.05) * 22 * (0.7 + rand() * 0.55)
  return Math.max(2, Math.min(28, Math.round(raw)))
}

export function buildRecordsSeed(seed = 20260824) {
  const rand = mulberry32(seed ^ 0x9e3779b9)
  const store: Record<string, RecordEntry[]> = {}

  const players = SEED_NAMES.map((name, i) => {
    const rankT = i / Math.max(1, SEED_NAMES.length - 1)
    const skill = Math.pow(1 - rankT, 0.7) * (0.5 + rand() * 0.5)
    const device = DEVICES[Math.floor(rand() * DEVICES.length)]
    return { name, skill, device, i }
  })

  // Highest combo — top ~55 players
  const comboKey = 'asteroids::highest-combo'
  store[comboKey] = players
    .filter((p) => p.skill > 0.28 || rand() < 0.2)
    .slice(0, 70)
    .map((p) =>
      entry(
        p.name,
        comboValue(p.skill, rand),
        stamp(Math.floor(rand() * 40), rand),
        p.device,
      ),
    )

  // Patriot perfect-hit streak
  const patriotStreakKey = 'patriot::direct-streak'
  store[patriotStreakKey] = players
    .filter((p) => p.skill > 0.22 || rand() < 0.25)
    .slice(0, 65)
    .map((p) =>
      entry(
        p.name,
        directStreakValue(p.skill, rand),
        stamp(Math.floor(rand() * 40), rand),
        p.device,
      ),
    )

  // Wave times — denser on early waves, thinner later
  for (let wave = 1; wave <= ASTEROIDS_WAVE_MAX; wave++) {
    const key = `asteroids::wave-time-${wave}`
    const depthNeed = wave / ASTEROIDS_WAVE_MAX
    const pool = players.filter((p) => p.skill >= depthNeed * 0.55 - 0.05)
    const count = Math.max(
      8,
      Math.min(55, Math.round(48 - wave * 1.6 + rand() * 6)),
    )
    store[key] = pool.slice(0, count).map((p) =>
      entry(
        p.name,
        waveTimeMs(wave, p.skill, rand),
        stamp(Math.floor(rand() * (20 + wave)), rand),
        p.device,
      ),
    )
  }

  // Snake length milestones
  for (
    let length = SNAKE_LENGTH_MILESTONE_MIN;
    length <= SNAKE_LENGTH_MILESTONE_MAX;
    length += SNAKE_LENGTH_MILESTONE_STEP
  ) {
    const key = `snake::fastest-length-${length}`
    const need = length / SNAKE_LENGTH_MILESTONE_MAX
    const pool = players.filter((p) => p.skill >= need * 0.5)
    const count = Math.max(
      10,
      Math.min(60, Math.round(52 - length * 0.28 + rand() * 5)),
    )
    store[key] = pool.slice(0, count).map((p) =>
      entry(
        p.name,
        lengthTimeMs(length, p.skill, rand),
        stamp(Math.floor(rand() * 35), rand),
        p.device,
      ),
    )
  }

  // Sanity: only known defs
  const allowed = new Set(
    listRecordDefs('asteroids')
      .concat(listRecordDefs('snake'))
      .concat(listRecordDefs('patriot'))
      .map((d) => `${d.game}::${d.id}`),
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
