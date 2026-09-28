/*
 * A copy of the site's src/games/halffull/plan.ts (ramseys-arcade), kept identical but for its imports, so the API builds
 * the same day of glasses and scores a pour to the same figure. Change both together;
 * `npm run check:halffull` compares them day by day.
 */

import { hashString, mulberry32 } from './seededRandom.js'
import {
  FAMILY_ORDER,
  LEVELS,
  absArea,
  absVolume,
  areaFrac,
  buildGlass,
  frac,
  levelForAbsVol,
  type Family,
  type Glass,
} from './glasses.js'

/*
 * A day of Half Full: four glasses to fill half full, easy to hard, and a fair split between a tall
 * glass and a wide one to finish. It grows from the date alone, the same for everyone, and nothing is
 * served: the site builds it, and the API builds the same day to check a score.
 *
 * How hard a day is comes from a modelled "reference pourer", who judges half partly by height, as
 * people do (Attwood et al. 2012 found a curved glass called half full at 35% of what it holds). Each
 * weekday has a band for that pourer's average miss, Monday easy to Sunday brutal, and a day keeps
 * drawing glasses until its five land in the band, with the pourer's over- and under-pours roughly
 * cancelling, so the glasses don't pick a player's team (Half-Full or Half-Empty) for them.
 *
 * Only arithmetic and Math.sqrt decide anything here (Math.log is swapped for detLog), so every JS
 * engine builds the same day.
 */

/** The reference pourer's pull toward judging by height: halfway between a first-timer and a regular. */
export const REF_K = 0.6

/** The reference pourer's average miss over the day's five, in points of volume, by weekday (0 = Sunday). */
export const BANDS: Record<number, readonly [lo: number, hi: number, label: DayLabel]> = {
  1: [2.0, 4.0, 'Easy'],
  2: [3.5, 5.5, 'Easy'],
  3: [5.0, 7.0, 'Medium'],
  4: [6.0, 8.0, 'Medium'],
  5: [7.0, 9.0, 'Tricky'],
  6: [8.0, 10.5, 'Hard'],
  0: [9.5, 13.0, 'Brutal'],
}

export type DayLabel = 'Easy' | 'Medium' | 'Tricky' | 'Hard' | 'Brutal'

/** The split's two sides: one glass that's tall for what it holds, one that's wide. */
const TALL: readonly Family[] = ['flute', 'can', 'bottle', 'hourglass', 'vase']
const WIDE: readonly Family[] = ['bowl', 'jar', 'bell', 'tumbler', 'fishbowl']
/** Glasses where half the height really is half: a day with one puts it third, against "always go higher". */
const FAKEOUTS: ReadonlySet<Family> = new Set(['can', 'fishbowl'])

/** How many glass sets a day may try before it keeps the closest. The plan check says none needs near this. */
const MAX_ATTEMPTS = 3000

/** A day that has to be drawn again (a bad glass, say): its salt re-rolls it. */
const OVERRIDES: Record<string, string> = {}

/* ---------- a logarithm from arithmetic alone ---------- */

const LN2 = 0.6931471805599453

/**
 * ln(x) from +, −, ×, ÷ only: Math.log may differ in its last bit between engines, and the split's
 * reference pour is decided by comparisons of logs.
 */
export function detLog(x: number): number {
  if (!(x > 0)) return Number.NEGATIVE_INFINITY
  let e = 0
  while (x > 1.4142135623730951) {
    x /= 2
    e++
  }
  while (x < 0.7071067811865476) {
    x *= 2
    e--
  }
  const z = (x - 1) / (x + 1)
  const z2 = z * z
  let term = z
  let sum = z
  for (let n = 3; n <= 41; n += 2) {
    term *= z2
    sum += term / n
  }
  return 2 * sum + e * LN2
}

/* ---------- the modelled pourer ---------- */

/** How full a pourer who leans `k` on the glass's height thinks it is at level L. */
export function perceived(g: Glass, L: number, k: number): number {
  const h = L / LEVELS
  return k * (0.55 * h + 0.45 * areaFrac(g, L)) + (1 - k) * frac(g, L)
}

/** Where that pourer stops, aiming for `target` (off by `eps`): an integer level. */
export function pickLevel(g: Glass, k: number, target: number, eps: number): number {
  const want = target + eps
  let lo = 0
  let hi = LEVELS
  if (perceived(g, 0, k) >= want) return 0
  if (perceived(g, LEVELS, k) <= want) return LEVELS
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (perceived(g, mid, k) < want) lo = mid
    else hi = mid
  }
  return Math.abs(perceived(g, lo, k) - want) <= Math.abs(perceived(g, hi, k) - want) ? lo : hi
}

/** The reference pourer's miss on a glass, in points (+ over, − under). */
export function refError(g: Glass): number {
  return 100 * (frac(g, pickLevel(g, REF_K, 0.5, 0)) - 0.5)
}

/* ---------- the split ---------- */

export type Split = {
  /** The tall one and the wide one, each drawn at its own `size` (widest radius) on one scale. */
  A: Glass
  B: Glass
  sizeA: number
  sizeB: number
  /** The juice shared between them. */
  J: number
  /** A's level can go from lo (B brim-full) to hi (A brim-full, or all the juice in A). */
  lo: number
  hi: number
  /** A's level at a fair split. */
  fairA: number
  /** A's level as the round begins. */
  start: number
  /** The reference pourer's miss, in points of A's share. */
  ref: number
}

/** A's share of the juice at A's level, 0..1. */
export function splitShare(s: Pick<Split, 'A' | 'sizeA' | 'J'>, levelA: number): number {
  return absVolume(s.A, s.sizeA, levelA) / s.J
}

/** B's level when A is at `levelA`. */
export function splitLevelB(s: Split, levelA: number): number {
  return levelForAbsVol(s.B, s.sizeB, s.J - absVolume(s.A, s.sizeA, levelA))
}

/** Where a pourer who leans `k` on height and area stops sharing: A's level, when the two look the same. */
export function splitPick(s: Split, k: number, eps: number): number {
  const { A, B, sizeA, sizeB, J, lo, hi } = s
  const f = (LA: number) => {
    const VA = absVolume(A, sizeA, LA)
    const VB = J - VA
    const LB = levelForAbsVol(B, sizeB, VB)
    const hA = Math.max(1e-6, (LA / LEVELS) * A.aspect * sizeA)
    const hB = Math.max(1e-6, (LB / LEVELS) * B.aspect * sizeB)
    const aA = Math.max(1e-9, absArea(A, sizeA, LA))
    const aB = Math.max(1e-9, absArea(B, sizeB, LB))
    return (
      k * (0.55 * detLog(hA / hB) + 0.45 * detLog(aA / aB)) +
      (1 - k) * detLog(Math.max(1e-9, VA) / Math.max(1e-9, VB)) -
      eps
    )
  }
  let a = lo
  let b = hi
  if (f(a) >= 0) return a
  if (f(b) <= 0) return b
  while (b - a > 1) {
    const mid = (a + b) >> 1
    if (f(mid) < 0) a = mid
    else b = mid
  }
  return Math.abs(f(a)) <= Math.abs(f(b)) ? a : b
}

function makeSplit(rng: () => number): Split {
  // Both kinds are drawn before either glass (the draws' order is the day's).
  const tall = TALL[Math.floor(rng() * TALL.length)]!
  const wide = WIDE[Math.floor(rng() * WIDE.length)]!
  const A = buildGlass(tall, rng)
  const B = buildGlass(wide, rng)
  const sizeOf = (g: Glass) => Math.min(1.0 / g.aspect, 0.45)
  const sizeA = sizeOf(A)
  const sizeB = sizeOf(B)
  const capA = absVolume(A, sizeA, LEVELS)
  const capB = absVolume(B, sizeB, LEVELS)
  const J = (0.9 + 0.45 * rng()) * Math.min(capA, capB)
  // The bisection never lands on an end exactly, so the ends are set outright: empty when the wide one can
  // take it all, brim-full when the tall one can.
  const lo = J <= capB ? 0 : Math.ceil(levelForAbsVol(A, sizeA, J - capB))
  const hi = J >= capA ? LEVELS : Math.floor(levelForAbsVol(A, sizeA, J))
  const fairA = levelForAbsVol(A, sizeA, J / 2)
  const s: Split = { A, B, sizeA, sizeB, J, lo, hi, fairA, start: 0, ref: 0 }
  s.ref = 100 * (splitShare(s, splitPick(s, REF_K, 0)) - 0.5)
  // A seeded start in the middle third of the range...
  let start = Math.round(lo + (hi - lo) * (0.33 + 0.34 * rng()))
  // ...but never within 6 points of fair: the round is to find fair, not to leave it be.
  const share = splitShare(s, start)
  if (Math.abs(share - 0.5) < 0.06) {
    const aim = share < 0.5 ? 0.435 : 0.565
    start = Math.min(hi, Math.max(lo, Math.round(levelForAbsVol(A, sizeA, aim * J))))
  }
  s.start = start
  return s
}

/* ---------- the day ---------- */

export type DayPlan = {
  day: string
  weekday: number
  label: DayLabel
  band: readonly [number, number]
  /** The four half glasses, easy to hard (a fake-out third). */
  pours: Glass[]
  /** The reference pourer's miss on each, in points. */
  refs: number[]
  split: Split
  /** The reference pourer's average miss over the five, in points. */
  mean: number
  /** |sum of the four signed misses| over the sum of their sizes: how far the day leans one way. */
  balance: number
  inBand: boolean
  attempts: number
  looks: DayLooks
}

/** What the day looks like, none of which changes a glass: a liquid a pour, a guest a glass, which side the tall one is. */
export type DayLooks = {
  /** Index into LIQUIDS, per round (the split is the fifth). */
  liquids: number[]
  /** Index into the guest cast, per half glass, then the split's two (A's, then B's). */
  guests: number[]
  /** Whether the split's tall glass stands on the left. */
  tallLeft: boolean
}

export function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay()
}

/** How many liquids and guests the looks pick from (looks.ts and the Find the Bug cast have them). */
export const LIQUID_COUNT = 8
export const GUEST_COUNT = 12

function pickLooks(day: string): DayLooks {
  const rng = mulberry32(hashString(`halffull:looks:${day}`))
  const deal = (n: number, count: number) => {
    const deck = Array.from({ length: count }, (_, i) => i)
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
    }
    return deck.slice(0, n)
  }
  return { liquids: deal(5, LIQUID_COUNT), guests: deal(6, GUEST_COUNT), tallLeft: rng() < 0.5 }
}

type Candidate = {
  glasses: Glass[]
  refs: number[]
  split: Split
  mean: number
  balance: number
  score: number
  attempt: number
}

function buildDay(day: string): DayPlan {
  const salt = OVERRIDES[day] ?? ''
  const rng = mulberry32(hashString(`halffull:${day}${salt}`))
  const wd = weekday(day)
  const [lo, hi, label] = BANDS[wd]!
  const wantFake = wd >= 3 || wd === 0 ? rng() < 0.35 : false
  let best: Candidate | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const fams: Family[] = []
    while (fams.length < 4) {
      const f = FAMILY_ORDER[Math.floor(rng() * FAMILY_ORDER.length)]!
      if (!fams.includes(f) && (wantFake || !FAKEOUTS.has(f))) fams.push(f)
    }
    const fakes = fams.filter((f) => FAKEOUTS.has(f)).length
    if (fakes !== (wantFake ? 1 : 0)) continue
    const glasses = fams.map((f) => buildGlass(f, rng))
    const refs = glasses.map(refError)
    const split = makeSplit(rng)
    const all = [...refs.map(Math.abs), Math.abs(split.ref)]
    const mean = all.reduce((a, b) => a + b, 0) / all.length
    const signed = refs.reduce((a, b) => a + b, 0)
    const absSum = refs.reduce((a, b) => a + Math.abs(b), 0)
    const balance = absSum > 0 ? Math.abs(signed) / absSum : 0
    const okHalf = glasses.every((g) => g.half >= 150 && g.half <= 880)
    const okSplit = split.hi - split.lo >= 300 && split.fairA > split.lo + 40 && split.fairA < split.hi - 40
    if (!okHalf || !okSplit) continue
    const score = (mean < lo ? lo - mean : mean > hi ? mean - hi : 0) + Math.max(0, balance - 0.25) * 10
    if (!best || score < best.score) best = { glasses, refs, split, mean, balance, score, attempt }
    if (score === 0) break
  }
  if (!best) throw new Error(`Half Full: no glasses for ${day}`)
  // Easy to hard; a fake-out goes third; the split is last.
  const order = best.glasses
    .map((g, i) => ({ g, ref: best!.refs[i]! }))
    .sort((a, b) => Math.abs(a.ref) - Math.abs(b.ref))
  const fakeAt = order.findIndex((o) => FAKEOUTS.has(o.g.family))
  if (fakeAt >= 0) {
    const [f] = order.splice(fakeAt, 1)
    order.splice(2, 0, f!)
  }
  return {
    day,
    weekday: wd,
    label,
    band: [lo, hi],
    pours: order.map((o) => o.g),
    refs: order.map((o) => o.ref),
    split: best.split,
    mean: best.mean,
    balance: best.balance,
    inBand: best.score === 0,
    attempts: best.attempt + 1,
    looks: pickLooks(day),
  }
}

const built = new Map<string, DayPlan>()

/** The day's glasses (built once a page). */
export function dayPlan(day: string): DayPlan {
  let plan = built.get(day)
  if (!plan) {
    plan = buildDay(day)
    built.set(day, plan)
  }
  return plan
}

/** Rounds a day: four half glasses and the split. */
export const ROUNDS = 5
export const HALF_ROUNDS = 4
