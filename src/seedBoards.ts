import {
  loadStore,
  replaceAllBoards,
  replaceGameBoard,
  type DeviceType,
  type GameSlug,
  type LeaderboardEntry,
} from './store.js'

/** Deterministic PRNG so re-seeds stay stable for a given revision. */
function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = [
  'PIXEL', 'JUNO', 'BLAST', 'ACE', 'HALO', 'KOI', 'NOVA', 'REX', 'MOCHI', 'ZAP',
  'TARO', 'WREN', 'FIZZ', 'BEE', 'GHOST', 'NIBBLE', 'DUSK', 'JESS', 'OTTO', 'MIX',
  'PEBBLE', 'MANGO', 'SAM', 'KIT', 'ORBIT', 'QUILL', 'DRIFT', 'LUMEN', 'SPARK', 'VOX',
  'CIDER', 'PULSE', 'GLINT', 'MARSH', 'IVY', 'COBALT', 'FLARE', 'HUSH', 'JET', 'KITE',
  'LARK', 'MINT', 'NEON', 'OPAL', 'PRISM', 'QUARTZ', 'RIVEN', 'SOL', 'TIDAL', 'UMBER',
  'VENN', 'WISP', 'XENON', 'YARROW', 'ZEST', 'ARROW', 'BRISK', 'CLOVER', 'DOME', 'EMBER',
  'FROST', 'GALE', 'HELM', 'IRIS', 'JADE', 'KEEL', 'LOOM', 'MIRTH', 'NORTH', 'OATS',
  'PIP', 'QUINCE', 'RAVEN', 'SAGE', 'TORN', 'ULTRA', 'VISTA', 'WAVE', 'YETI', 'ZINC',
  'ASTRO', 'BOLT', 'CRUX', 'DASH', 'ECHO', 'FLUX', 'GRIT', 'HEX', 'ION', 'JOLT',
  'KNACK', 'LOOP', 'MESH', 'NIX', 'ONYX', 'PEAK', 'QUAD', 'ROOK', 'SYNC', 'TWIG',
  'UNIT', 'VOLT', 'WOLF', 'YOLK', 'ZED', 'ARC', 'BINX', 'CHIP', 'DOJO', 'ELAN',
  'FOAM', 'GLUE',
] as const

const DEVICES: DeviceType[] = ['phone', 'tablet', 'desktop']

type ScoreProfile = {
  min: number
  max: number
  /** Round to this step (e.g. snake scores are multiples of 10). */
  step?: number
}

/** Realistic score bands by skill 0 (casual) → 1 (elite). */
const GAME_BANDS: Record<GameSlug, ScoreProfile> = {
  stacker: { min: 6, max: 118 },
  patriot: { min: 480, max: 28600, step: 5 },
  snake: { min: 30, max: 1180, step: 10 },
  pop: { min: 70, max: 920, step: 5 },
  'dead-center': { min: 420, max: 7420, step: 10 },
  asteroids: { min: 280, max: 14200, step: 10 },
  simon: { min: 2, max: 26 },
  crosswalk: { min: 40, max: 1680, step: 10 },
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function roundTo(value: number, step = 1) {
  return Math.max(0, Math.round(value / step) * step)
}

function scoreFor(game: GameSlug, skill: number, rand: () => number) {
  const band = GAME_BANDS[game]
  // Bias toward mid-low with a long tail of strong runs
  const shaped = Math.pow(skill, 1.35) * (0.82 + rand() * 0.36)
  const raw = lerp(band.min, band.max, Math.min(1, shaped))
  const jitter = 1 + (rand() - 0.5) * 0.14
  return roundTo(raw * jitter, band.step ?? 1)
}

/** Timestamps relative to now so daily / weekly / monthly boards always look populated. */
function stampForBucket(
  bucket: 'today' | 'week' | 'month' | 'older',
  rand: () => number,
) {
  const hour = 8 + Math.floor(rand() * 14)
  const minute = Math.floor(rand() * 60)
  const second = Math.floor(rand() * 60)
  const now = Date.now()
  if (bucket === 'today') {
    return now - Math.floor(rand() * 14 * 3600_000) - minute * 1000
  }
  if (bucket === 'week') {
    const days = 1 + Math.floor(rand() * 5)
    return now - days * 86_400_000 - hour * 3600_000 - minute * 60_000 - second * 1000
  }
  if (bucket === 'month') {
    const days = 8 + Math.floor(rand() * 20)
    return now - days * 86_400_000 - hour * 3600_000 - minute * 60_000
  }
  const days = 35 + Math.floor(rand() * 70)
  return now - days * 86_400_000 - hour * 3600_000
}

function pickBucket(i: number, rand: () => number): 'today' | 'week' | 'month' | 'older' {
  // Elites (low index / high skill) stay off today so the all-time podium
  // isn’t mirrored on the daily board. Mid/casual names fill today.
  const rankT = i / Math.max(1, NAMES.length - 1)
  if (rankT < 0.14) {
    return rand() < 0.4 ? 'month' : 'older'
  }
  if (rankT < 0.32) {
    const roll = Math.floor(rand() * 100)
    if (roll < 55) return 'week'
    if (roll < 85) return 'month'
    return 'older'
  }
  const roll = (i * 17 + Math.floor(rand() * 100)) % 100
  if (roll < 34) return 'today'
  if (roll < 58) return 'week'
  if (roll < 82) return 'month'
  return 'older'
}

function entry(
  name: string,
  score: number,
  at: number,
  device: DeviceType,
): LeaderboardEntry {
  const tag = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  return {
    id: `${at}-${tag}${score}`,
    name,
    score,
    at,
    device,
  }
}

export function buildSeed(seed = 20260827) {
  const rand = mulberry32(seed)
  const games = Object.keys(GAME_BANDS) as GameSlug[]
  const store: Record<GameSlug, LeaderboardEntry[]> = {
    stacker: [],
    patriot: [],
    snake: [],
    pop: [],
    'dead-center': [],
    asteroids: [],
    simon: [],
    crosswalk: [],
  }

  NAMES.forEach((name, i) => {
    // Skill curve: a few elites, many mid, long casual tail
    const rankT = i / Math.max(1, NAMES.length - 1)
    const skill = Math.pow(1 - rankT, 0.72) * (0.55 + rand() * 0.45)
    const device = DEVICES[Math.floor(rand() * DEVICES.length)]
    const bucket = pickBucket(i, rand)
    const at = stampForBucket(bucket, rand)

    for (const game of games) {
      // Most players have every game; a few skip 1–2 so boards feel uneven
      if (rand() < 0.06) continue
      const score = scoreFor(game, skill, rand)
      if (score <= 0) continue
      store[game].push(entry(name, score, at + Math.floor(rand() * 90_000), device))
    }
  })

  return store
}

const PLACEHOLDER_NAME = /^(ME2?|TEST|YOU|RAMSEY-TEST\d*)$/

export function isPlaceholderStore() {
  const store = loadStore()
  const entries = [
    ...store.stacker,
    ...store.patriot,
    ...store.snake,
    ...(store.pop ?? []),
    ...(store['dead-center'] ?? []),
    ...(store.asteroids ?? []),
    ...(store.simon ?? []),
  ]
  if (entries.length === 0) return true
  return entries.every((e) => PLACEHOLDER_NAME.test(e.name))
}

export function seedLeaderboards(force = false) {
  if (!force && !isPlaceholderStore()) return false
  replaceAllBoards(buildSeed())
  return true
}

export function seedGame(game: GameSlug) {
  const entries = buildSeed()[game]
  if (!entries) return false
  replaceGameBoard(game, entries)
  return true
}

export { NAMES as SEED_NAMES }
