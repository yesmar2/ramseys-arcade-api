/*
 * How each game plays, for the seeded world: one run by a player of a given
 * ability, with the score it posts, how long it took, and what it puts in the
 * record books on the way.
 *
 * The shapes come from the games themselves. Every game on the site has a
 * pilot that plays its real engine for its cabinet on the home page, and forty
 * runs of each (September 2026) set where a strong player lands and how the
 * parts of a run hang together: how long a snake is for its score, how fast
 * rows and waves go by, how long a streak runs, how many points a second a
 * game gives. The rest of the range, down to someone's first go, follows the
 * games' own rules.
 *
 * Ability `q` runs from 0, a first try, to 1, the best on the site. Luck sits
 * on top of it, so a good player still has bad runs. Every run is kept inside
 * what the API itself would accept for the time it took.
 */

import { rateAllowance } from './scoreLimits.js'
import type { GameSlug } from './store.js'

export type Rng = () => number

/** A value a run posts to a record book, and when in the run it was posted. */
export type RunRecord = {
  recordId: string
  value: number
  /** Milliseconds from the run id being issued, like the score's duration. */
  atMs: number
}

export type SeedRun = {
  score: number
  /** From the run id being issued to the score arriving: what the API measures. */
  durationMs: number
  records: RunRecord[]
}

/**
 * Every game on the site except Simon, which retired, Spotter, which is hidden, and the dailies, whose
 * boards are each day's own: they're played by the day (SEEDED_DAILIES, below).
 */
export const SEEDED_GAMES: readonly GameSlug[] = [
  'asteroids',
  'patriot',
  'snake',
  'crosswalk',
  'stacker',
  'centroid',
  'pop',
  'pellets',
  'crumbtrail',
  'bop',
  'putt',
  'barrage',
  'frenzy',
  'fireflies',
]

/* ---------- shapes ---------- */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1)
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo)
const roundTo = (v: number, step: number) => Math.max(0, Math.round(v / step) * step)

/** A path through three points, even in ratio: `a` at q = 0, `b` at 0.5, `c` at 1. */
function curve(q: number, a: number, b: number, c: number) {
  const t = clamp(q, 0, 1)
  return t < 0.5 ? a * Math.pow(b / a, t * 2) : b * Math.pow(c / b, (t - 0.5) * 2)
}

function gauss(rng: Rng) {
  let u = 0
  while (u === 0) u = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/**
 * Run-to-run luck: 1 in the middle. A run can go wrong in any number of ways,
 * so the bad side runs long; it can only go so right before the game's own
 * pace catches up, so the good side is short. `sigma` sets the bad side, and
 * the good side is under half of it. A player's best is then a good day, not
 * a freak one, and a board's leaders sit close to each other.
 */
function luck(rng: Rng, sigma: number) {
  const g = gauss(rng)
  return Math.exp(g < 0 ? g * sigma : g * sigma * 0.45)
}

/**
 * Bend a value toward a ceiling instead of stopping it there. Past `knee` it
 * closes on `ceiling` ever more slowly, so the very best runs crowd near the
 * top of what the game allows without a row of them tied on the limit.
 */
function soften(v: number, knee: number, ceiling: number) {
  if (v <= knee) return v
  const room = ceiling - knee
  return knee + room * Math.tanh((v - knee) / room)
}

function poisson(rng: Rng, mean: number) {
  const limit = Math.exp(-mean)
  let k = 0
  let p = 1
  do {
    k += 1
    p *= rng()
  } while (p > limit)
  return k - 1
}

/** When each of `count` steps lands, each taking about `pace` seconds. */
function stepTimes(rng: Rng, count: number, pace: number, wobble: number): number[] {
  const out: number[] = []
  let t = 0
  for (let i = 0; i < count; i++) {
    t += pace * between(rng, 1 - wobble, 1 + wobble)
    out.push(t)
  }
  return out
}

/** Record books whose value is a time, which stretch with the run. */
function isTimed(recordId: string) {
  return /^(wave-time|fastest-length|fastest-row)-/.test(recordId)
}

/**
 * Put a run's clock around its play: a moment before the first move, a moment
 * after the last, and, if the score came faster than the API allows, a slower
 * run. The API measures from the run id to the score and refuses a score the
 * time could not have produced, so no seeded run sits near that line.
 */
function finish(game: GameSlug, rng: Rng, score: number, playSecs: number, records: RunRecord[]): SeedRun {
  const before = between(rng, 2.5, 6)
  const after = between(rng, 1.5, 4)
  let play = Math.max(1, playSecs)
  let stretch = 1
  const allowed = (secs: number) => rateAllowance(game, secs * 1000)
  if (allowed(before + play + after) != null) {
    while (score > 0.85 * allowed(before + play * stretch + after)! && stretch < 6) stretch *= 1.04
  }
  play *= stretch
  return {
    score,
    durationMs: Math.round((before + play + after) * 1000),
    records: records.map((r) => ({
      recordId: r.recordId,
      value: isTimed(r.recordId) ? Math.max(1, Math.round(r.value * stretch)) : r.value,
      atMs: Math.round((before + (r.atMs / 1000) * stretch) * 1000),
    })),
  }
}

/* ---------- the games ---------- */

type Model = (q: number, rng: Rng) => SeedRun

/**
 * Waves of 4 + n rocks, up to twelve, each rock worth its pieces at the
 * combo the player keeps. A wave's clear time is its own clock, not the run's.
 */
const asteroids: Model = (q, rng) => {
  const cleared = Math.floor(soften(curve(q, 1.1, 3.0, 5.8) * luck(rng, 0.32), 9, 16))
  const speed = lerp(1.45, 0.62, q) * between(rng, 0.9, 1.12)
  const perRock = lerp(430, 640, q) * between(rng, 0.9, 1.1)
  const records: RunRecord[] = []
  let t = 0
  let score = 0
  for (let wave = 1; wave <= cleared; wave++) {
    const rocks = Math.min(4 + wave, 12)
    const secs = (7 + rocks * 3.4) * speed * luck(rng, 0.18)
    t += secs
    const par = Math.max(28, 48 - (wave - 1) * 2)
    score += rocks * perRock * luck(rng, 0.1) + (wave + 1) * 50 + Math.max(0, Math.round(par - secs)) * 20
    records.push({ recordId: `wave-time-${wave}`, value: Math.round(secs * 1000), atMs: t * 1000 })
  }
  const rocks = Math.min(5 + cleared, 12)
  const share = rng() * 0.85
  t += (7 + rocks * 3.4) * speed * Math.max(0.15, share) * between(rng, 0.9, 1.4)
  score += rocks * perRock * share
  const reach = Math.min(1, (cleared + share) / 4)
  const combo = Math.round(curve(q, 3, 11, 26) * luck(rng, 0.3) * (0.55 + 0.45 * reach))
  if (combo >= 2) records.push({ recordId: 'highest-combo', value: combo, atMs: t * 1000 })
  return finish('asteroids', rng, roundTo(score, 1), t, records)
}

const patriot: Model = (q, rng) => {
  const score = roundTo(Math.max(60, soften(curve(q, 850, 5000, 15_000) * luck(rng, 0.34), 26_000, 40_000)), 5)
  const play = score / (lerp(48, 88, q) * between(rng, 0.85, 1.15))
  const records: RunRecord[] = []
  const direct = Math.round(curve(q, 1.3, 4, 11) * luck(rng, 0.35))
  if (direct >= 2) records.push({ recordId: 'direct-streak', value: direct, atMs: play * 1000 })
  return finish('patriot', rng, score, play, records)
}

/**
 * Three segments to start, one a fruit. A fruit is worth more the longer the
 * chain behind it, so the score per fruit climbs with length: the pilot's runs
 * sit on foods × (21 + 0.17 × foods) to within a few percent.
 */
const snake: Model = (q, rng) => {
  const foods = Math.max(1, Math.round(soften(curve(q, 6, 22, 48) * luck(rng, 0.32), 70, 104)))
  const length = 3 + foods
  const score = roundTo(foods * (21 + 0.17 * foods) * between(rng, 0.95, 1.05), 2)
  const times = stepTimes(rng, foods, lerp(2.8, 1.6, q) * between(rng, 0.92, 1.1), 0.4)
  const records: RunRecord[] = []
  for (let m = 20; m <= 100; m += 10) {
    if (length < m) break
    const at = times[m - 4]! * 1000
    records.push({ recordId: `fastest-length-${m}`, value: Math.round(at), atMs: at })
  }
  const play = times[foods - 1]! + between(rng, 1, 6)
  if (length >= 8) records.push({ recordId: 'longest', value: length, atMs: play * 1000 })
  return finish('snake', rng, score, play, records)
}

/** The score is the furthest row. Coins, chains and close calls come with distance. */
const crosswalk: Model = (q, rng) => {
  const rows = Math.max(1, Math.round(soften(curve(q, 16, 60, 160) * luck(rng, 0.38), 260, 420)))
  const times = stepTimes(rng, rows, lerp(0.95, 0.4, q) * between(rng, 0.9, 1.12), 0.45)
  const records: RunRecord[] = []
  for (let m = 50; m <= 200; m += 25) {
    if (rows < m) break
    const at = times[m - 1]! * 1000
    records.push({ recordId: `fastest-row-${m}`, value: Math.round(at), atMs: at })
  }
  const play = times[rows - 1]! + between(rng, 0.5, 4)
  const end = play * 1000
  const coins = Math.round(rows * between(rng, 0.015, 0.11))
  if (coins >= 1) records.push({ recordId: 'most-coins', value: coins, atMs: end })
  const chain = Math.min(rows, Math.round(rows * between(rng, 0.12, 0.42) + between(rng, 2, 10)))
  if (chain >= 6) records.push({ recordId: 'longest-chain', value: chain, atMs: end })
  const calls = poisson(rng, rows * between(rng, 0.004, 0.03))
  if (calls >= 3) records.push({ recordId: 'near-misses', value: calls, atMs: end })
  return finish('crosswalk', rng, rows, play, records)
}

const stacker: Model = (q, rng) => {
  const blocks = Math.max(1, Math.round(soften(curve(q, 7, 20, 50) * luck(rng, 0.3), 80, 130)))
  const play = blocks * lerp(2.3, 1.6, q) * between(rng, 0.9, 1.1) + between(rng, 1, 3)
  const records: RunRecord[] = []
  const perfect = Math.min(blocks, Math.round(curve(q, 1.3, 3.5, 11) * luck(rng, 0.4)))
  if (perfect >= 2) records.push({ recordId: 'perfect-streak', value: perfect, atMs: play * 1000 })
  return finish('stacker', rng, blocks, play, records)
}

/**
 * Plates until the pins run out: three pins, one lost per fallen plate, one
 * back per ten in a row. A balanced plate is 20, up to 80 more for accuracy,
 * 30 for dead center and 20 for speed, times the streak.
 */
const centroid: Model = (q, rng) => {
  const balanced = Math.round(soften(curve(q, 3, 9, 24) * luck(rng, 0.38), 45, 75))
  const fallen = 3 + Math.floor(balanced / 14)
  const score = Math.round(balanced * lerp(62, 122, q) * between(rng, 0.9, 1.1))
  const play = (balanced + fallen) * lerp(4.4, 3.1, q) * between(rng, 0.9, 1.1)
  return finish('centroid', rng, score, play, [])
}

/** A 45-second round. */
const pop: Model = (q, rng) => {
  const score = roundTo(soften(curve(q, 420, 1300, 2350) * luck(rng, 0.15), 2250, 2880), 5)
  const play = 45 + between(rng, 0.5, 2)
  const records: RunRecord[] = []
  const center = Math.round(curve(q, 1.2, 3, 8.5) * luck(rng, 0.4))
  if (center >= 2) records.push({ recordId: 'center-streak', value: center, atMs: play * 1000 })
  return finish('pop', rng, score, play, records)
}

const pellets: Model = (q, rng) => {
  const score = roundTo(Math.max(50, soften(curve(q, 650, 3300, 11_000) * luck(rng, 0.38), 20_000, 34_000)), 10)
  const play = score / (lerp(42, 92, q) * between(rng, 0.8, 1.2))
  const records: RunRecord[] = []
  const crumbs = Math.round(curve(q, 9, 22, 46) * luck(rng, 0.25) * (0.8 + 0.2 * Math.min(1, score / 5000)))
  if (crumbs >= 10) records.push({ recordId: 'crumb-streak', value: crumbs, atMs: play * 1000 })
  return finish('pellets', rng, score, play, records)
}

/** An endless climb: rows, crumbs and the odd chaser eaten while frightened. */
const crumbtrail: Model = (q, rng) => {
  const score = roundTo(Math.max(50, soften(curve(q, 1000, 5200, 14_000) * luck(rng, 0.38), 26_000, 42_000)), 5)
  const depth = Math.max(1, Math.round(score / between(rng, 42, 70)))
  const play = depth * lerp(0.48, 0.3, q) * between(rng, 0.9, 1.15)
  const end = play * 1000
  const records: RunRecord[] = []
  if (depth >= 10) records.push({ recordId: 'most-rows', value: depth, atMs: end })
  const crumbs = Math.round(curve(q, 14, 42, 105) * luck(rng, 0.3))
  if (crumbs >= 10) records.push({ recordId: 'crumb-streak', value: crumbs, atMs: end })
  const eaten = poisson(rng, (depth / 160) * lerp(0.3, 1.6, q))
  if (eaten >= 2) records.push({ recordId: 'chasers-eaten', value: eaten, atMs: end })
  return finish('crumbtrail', rng, score, play, records)
}

const bop: Model = (q, rng) => {
  const score = Math.max(1, Math.round(soften(curve(q, 11, 34, 80) * luck(rng, 0.26), 115, 160)))
  const play = score * lerp(0.8, 0.58, q) * between(rng, 0.9, 1.1) + between(rng, 1, 3)
  return finish('bop', rng, score, play, [])
}

/** Putt's five short holes and their pars (the site's games/putt/course.ts). */
const PUTT_PARS = [2, 2, 2, 2, 2]

/** Each hole pays 100 a stroke under par plus two, and an ace 200 more. */
const putt: Model = (q, rng) => {
  // Strokes over par a hole: a casual player's about one over, the best half a stroke under, aces and all.
  const offset = lerp(1, -0.5, q)
  const spread = lerp(0.8, 0.6, q)
  let score = 0
  let strokes = 0
  for (const par of PUTT_PARS) {
    const s = Math.max(1, Math.round(par + offset + gauss(rng) * spread))
    strokes += s
    score += Math.max(0, par + 2 - s) * 100 + (s === 1 ? 200 : 0)
  }
  // Each hole's fly-over and drop, and each stroke's look, pull and roll.
  const play = strokes * between(rng, 5.5, 8) + PUTT_PARS.length * between(rng, 3, 4.5)
  return finish('putt', rng, score, play, [])
}

const barrage: Model = (q, rng) => {
  const score = Math.max(50, Math.round(soften(curve(q, 850, 6500, 26_000) * luck(rng, 0.42), 50_000, 90_000)))
  const play = score / (lerp(38, 115, q) * between(rng, 0.85, 1.15))
  return finish('barrage', rng, score, play, [])
}

/**
 * Points follow the size you have grown to, so a run's score climbs with the
 * square of its length. An excellent run lands near fifteen thousand.
 */
const frenzy: Model = (q, rng) => {
  const score = Math.max(1, Math.round(soften(curve(q, 110, 2300, 10_000) * luck(rng, 0.45), 20_000, 34_000)))
  const play = Math.sqrt(score / (lerp(0.12, 0.95, q) * between(rng, 0.8, 1.2))) + between(rng, 8, 20)
  return finish('frenzy', rng, score, play, [])
}

/** A night's rounds, dealt as the game deals them. */
const FIREFLY_NIGHTS = [
  ['tune', 'tune', 'catch', 'tune', 'follow'],
  ['tune', 'catch', 'tune', 'follow', 'tune'],
  ['tune', 'follow', 'tune', 'catch', 'tune'],
] as const

/**
 * Nights of five lanterns, a round won lighting one. A tune is a point a note,
 * 3 + t notes for the t-th, sung then sung back; the run ends at the first
 * wrong firefly, likelier as the tune outgrows what the player can hold. A
 * Catch pays a point a catch and lights its lantern at eight, from fewer
 * chances as the nights shorten them; a Follow pays 3 when found. A lost
 * Catch or Follow only leaves its lantern dark, so the night plays on, and a
 * full string rings for 5.
 */
const fireflies: Model = (q, rng) => {
  const span = lerp(5, 14, q) * between(rng, 0.88, 1.12)
  let score = 0
  let t = 1
  let tunes = 0
  for (let night = 1; night < 40; night++) {
    const plan = FIREFLY_NIGHTS[(night - 1) % FIREFLY_NIGHTS.length]!
    let lit = 0
    for (let played = 0; lit < 5; played++) {
      const kind = plan[played % plan.length]!
      if (kind === 'tune') {
        const len = 3 + tunes
        const watch = len * lerp(0.62, 0.45, tunes / 20) + 1.6
        const slip = 0.02 + 0.9 / (1 + Math.exp(-(len - span) / 1.1))
        if (rng() < slip) {
          const got = Math.floor(rng() * len)
          return finish('fireflies', rng, score + got, t + watch + got * 0.55 + 1, [])
        }
        score += len
        t += watch + len * 0.55
        tunes += 1
        lit += 1
      } else if (kind === 'catch') {
        const window = Math.max(0.5, 0.95 - 0.11 * (night - 1))
        const caught = Math.round(clamp(13 * lerp(0.55, 0.95, q) * Math.sqrt(window / 0.95) * between(rng, 0.8, 1.1), 0, 14))
        score += caught
        t += 11
        if (caught >= 8) lit += 1
      } else {
        if (rng() < clamp(lerp(0.72, 0.97, q) - (night - 1) * 0.03, 0.3, 0.97)) {
          score += 3
          lit += 1
        }
        t += 6 + night * 0.6
      }
    }
    score += 5
    t += 4
  }
  return finish('fireflies', rng, score, t, [])
}

const MODELS: Partial<Record<GameSlug, Model>> = {
  asteroids,
  patriot,
  snake,
  crosswalk,
  stacker,
  centroid,
  pop,
  pellets,
  crumbtrail,
  bop,
  putt,
  barrage,
  frenzy,
  fireflies,
}

/** One run of `game` by a player whose ability in it is `q` today. */
export function playRun(game: GameSlug, q: number, rng: Rng): SeedRun {
  const model = MODELS[game]
  if (!model) throw new Error(`No seed model for ${game}`)
  return model(clamp(q, 0, 1), rng)
}

/* ---------- the dailies ---------- */

/**
 * The dailies: the same track, hole, scenes or glasses for everyone each day, so seedWorld.ts plays them by
 * the day, from each one's first. `hard` is the day's own difficulty, the same for everyone: 1 an ordinary
 * day, more a harder one.
 */
export const SEEDED_DAILIES: readonly GameSlug[] = ['hotlap', 'acechase', 'findbug', 'halffull']

/**
 * A Hot Lap lap in milliseconds, on a track whose blue car goes round in `pace`: a middling driver about
 * level with the blue car, the day's best seeded lap about 85% of its time (the site's own best laps so
 * far are 81 to 85%), a first go a good way behind. A slip or a wall costs seconds and a clean lap gains
 * little, and the laps of a sitting learn the track a bit.
 */
export function hotLapMs(q: number, pace: number, lap: number, rng: Rng): number {
  const g = gauss(rng)
  const form = g > 0 ? 1 + g * 0.05 : 1 + g * 0.012
  const share = curve(clamp(q, 0, 1), 1.3, 0.97, 0.74) * (1 - 0.006 * Math.min(lap, 3)) * form
  return Math.round(pace * Math.max(0.815, share))
}

/**
 * The tries a player's first bullseye takes at Today's Hole. An ace is rare, two is a very good day, and
 * past that the tries run long for a new player: the ticket ladder (3 to 15 tries) reads the same way.
 */
export function aceChaseTries(q: number, hard: number, rng: Rng): number {
  const u = rng()
  const ace = (0.003 + 0.012 * q * q) / hard
  const two = (0.03 + 0.08 * q * q) / hard
  if (u < ace) return 1
  if (u < ace + two) return 2
  const mean = (0.8 + 7 * Math.pow(1 - clamp(q, 0, 1), 1.3)) * hard
  return Math.min(30, 3 + Math.floor(-Math.log(1 - rng() * 0.999) * mean))
}

/** A day's tries as letters, as Today's Hole keeps them (b bull, i inner, o outer, x off, l lost): closer as it goes. */
export function aceChasePattern(tries: number, rng: Rng): string {
  let out = ''
  for (let i = 0; i < tries - 1; i++) {
    const near = (i + 1) / tries
    const r = rng()
    out += r < 0.06 ? 'l' : r < 0.35 - near * 0.2 ? 'x' : r < 0.75 - near * 0.1 ? 'o' : 'i'
  }
  return `${out}b`
}

/** Today's Wanted's five scenes, in milliseconds: the old sweep's shape, on the day's scenes. */
export function findBugMs(q: number, hard: number, rng: Rng): number {
  const secs = Math.min(400, 25 + ((curve(clamp(q, 0, 1), 118, 56, 31) - 25) * hard) / luck(rng, 0.3))
  return Math.round(secs * 1000)
}

/**
 * Today's Pour, as its board keeps it: hundredths of a point (9124 is 91.2%). Each of five pours lands
 * some way off half, a steady hand within a point or two and a first go five or ten off, and now and then
 * a glass is judged by its height rather than what it holds. A pour scores 100 less two a point off, to a
 * tenth, and the day is their mean (the API's halffull/score.ts).
 */
export function halfFullFigure(q: number, hard: number, rng: Rng): number {
  const spread = curve(clamp(q, 0, 1), 11, 4.5, 1.6) * hard
  let total = 0
  for (let i = 0; i < 5; i++) {
    let off = Math.abs(gauss(rng)) * spread
    if (rng() < 0.22 * (1 - q)) off += between(rng, 6, 24)
    total += Math.max(0, 100 - 2 * (Math.round(off * 10) / 10))
  }
  return Math.floor((100 * total) / 5 + 1e-6)
}
