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

/** Wave clear times in ms — seeded slow so normal clears beat them easily. */
function waveTimeMs(wave: number, skill: number, rand: () => number) {
  const baseSec = 36 + wave * 11 + wave * wave * 0.75
  const slack = 1.08 + (1 - skill) * 0.42 + rand() * 0.22
  return Math.round(baseSec * 1000 * slack)
}

/** Fastest-to-length times in ms — seeded slow for testing. */
function lengthTimeMs(length: number, skill: number, rand: () => number) {
  const foods = Math.max(1, length - 3)
  const secPerFood = 2.4 - skill * 0.75 + rand() * 0.55
  return Math.max(8_000, Math.round(foods * secPerFood * 1000))
}

function comboValue(skill: number, rand: () => number) {
  const raw = 2 + skill * 5 + rand() * 4
  return Math.max(2, Math.min(10, Math.round(raw)))
}

function directStreakValue(skill: number, rand: () => number) {
  const raw = 2 + skill * 4 + rand() * 3
  return Math.max(2, Math.min(8, Math.round(raw)))
}

export function buildRecordsSeed(seed = 20260825) {
  const rand = mulberry32(seed ^ 0x9e3779b9)
  const store: Record<string, RecordEntry[]> = {}

  const players = SEED_NAMES.map((name, i) => {
    const rankT = i / Math.max(1, SEED_NAMES.length - 1)
    const skill = Math.pow(1 - rankT, 0.7) * (0.5 + rand() * 0.5)
    const device = DEVICES[Math.floor(rand() * DEVICES.length)]
    return { name, skill, device, i }
  })

  // Highest combo — a few modest scores
  const comboKey = 'asteroids::highest-combo'
  store[comboKey] = players
    .filter((p) => p.skill > 0.15 || rand() < 0.35)
    .slice(0, 12)
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
    .filter((p) => p.skill > 0.12 || rand() < 0.35)
    .slice(0, 12)
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
    const pool = players.filter((p) => p.skill >= depthNeed * 0.35 - 0.1)
    const count = Math.max(4, Math.min(14, Math.round(10 - wave * 0.2 + rand() * 3)))
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
    const pool = players.filter((p) => p.skill >= need * 0.35)
    const count = Math.max(4, Math.min(12, Math.round(10 - length * 0.04 + rand() * 2)))
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
