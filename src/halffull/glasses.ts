/*
 * A copy of the site's src/games/halffull/glasses.ts (ramseys-arcade), kept identical but for its imports, so the API builds
 * the same day of glasses and scores a pour to the same figure. Change both together;
 * `npm run check:halffull` compares them day by day.
 */

/*
 * Half Full's glasses: the inside of each one, as it's filled, and how much it holds below any line.
 *
 * A glass is 51 knots up its inside, each an integer radius from 0 to 1000 of its widest, and a level is
 * an integer from 0 (empty) to 1000 (the rim). Everything here is arithmetic and Math.sqrt, which every
 * JS engine rounds the same way, so the site and the API build the same glass to the last bit and agree
 * on a score to the integer (plan.ts says the same of the day's choices).
 *
 * The families are the kinds of shape; each draws its own numbers from the day's generator, in a fixed
 * order, so the draws below must not be reordered or the glasses of every day change.
 */

export const K = 50
export const LEVELS = 1000
const PER_SEG = LEVELS / K

export type Family =
  | 'can'
  | 'tumbler'
  | 'jar'
  | 'cone'
  | 'flute'
  | 'flask'
  | 'bowl'
  | 'fishbowl'
  | 'vase'
  | 'hourglass'
  | 'bottle'
  | 'tulip'
  | 'bell'

type Rng = () => number

/** A shape's radius up its height (both 0..1, widest about 1) and its height-to-widest range. */
type Shape = { r: (y: number) => number; aspect: [number, number] }

/* ---------- a monotone cubic through a few points (Fritsch–Carlson), arithmetic only ---------- */

function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length
  const h: number[] = []
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1]! - xs[i]!
    d[i] = (ys[i + 1]! - ys[i]!) / h[i]!
  }
  const m: number[] = new Array(n)
  m[0] = d[0]!
  m[n - 1] = d[n - 2]!
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1]! * d[i]! <= 0) m[i] = 0
    else {
      const w1 = 2 * h[i]! + h[i - 1]!
      const w2 = h[i]! + 2 * h[i - 1]!
      m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!)
    }
  }
  return (x) => {
    let i = 0
    while (i < n - 2 && x > xs[i + 1]!) i++
    const t = (x - xs[i]!) / h[i]!
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h[i]! * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h[i]! * m[i + 1]!
    )
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Every family, in the order a day picks from (don't reorder: the day's draws index into it). `names`
 * are what the glass is called in play ("Pip's party cup"); only their count touches the draws.
 */
export const FAMILIES: Record<Family, { names: readonly [string, string, string]; make: (R: Rng) => Shape }> = {
  can: { names: ['tall glass', 'highball', 'tall glass'], make: () => ({ r: () => 1, aspect: [1.6, 2.6] }) },
  tumbler: {
    names: ['tumbler', 'party cup', 'milkshake cup'],
    make: (R) => {
      const b = lerp(0.58, 0.86, R())
      return { r: (y) => lerp(b, 1, y), aspect: [1.3, 2.4] }
    },
  },
  jar: {
    names: ['jam jar', 'sweet jar', 'honey pot'],
    make: (R) => {
      const t = lerp(0.58, 0.86, R())
      return { r: (y) => lerp(1, t, y), aspect: [1.1, 2.0] }
    },
  },
  cone: {
    names: ['snow cone cup', 'party hat cup', 'paper cone'],
    make: (R) => {
      const tip = lerp(0.03, 0.18, R())
      const c = lerp(-0.35, 0.45, R())
      return { r: (y) => tip + (1 - tip) * y * (1 + c * (1 - y)), aspect: [1.1, 2.6] }
    },
  },
  flute: {
    names: ['sundae glass', 'trumpet glass', 'float glass'],
    make: (R) => {
      const b = lerp(0.16, 0.3, R())
      const mid = lerp(0.26, 0.42, R())
      const at = lerp(0.5, 0.7, R())
      return { r: pchip([0, at, 1], [b, mid, 1]), aspect: [2.6, 4.2] }
    },
  },
  flask: {
    names: ['potion flask', 'science flask', 'volcano flask'],
    make: (R) => {
      const n = lerp(0.2, 0.34, R())
      const ys = lerp(0.62, 0.8, R())
      return { r: (y) => (y <= ys ? 1 - (1 - n) * (y / ys) : n), aspect: [1.2, 1.9] }
    },
  },
  bowl: {
    names: ['goblet', 'sundae bowl', 'punch bowl'],
    make: (R) => {
      const q = lerp(0.8, 0.97, R())
      return { r: (y) => Math.sqrt(1 - (1 - y) * (1 - y) * q), aspect: [0.8, 1.4] }
    },
  },
  fishbowl: {
    names: ['fishbowl', 'crystal ball', 'snow globe'],
    make: (R) => {
      const o = lerp(0.4, 0.66, R())
      const b = lerp(0.28, 0.5, R())
      const zt = Math.sqrt(1 - o * o)
      const zb = -Math.sqrt(1 - b * b)
      return {
        r: (y) => {
          const z = zb + (zt - zb) * y
          return Math.sqrt(Math.max(0, 1 - z * z))
        },
        aspect: [1.5, 1.95],
      }
    },
  },
  vase: {
    names: ['flower vase', 'genie lamp', 'gourd'],
    make: (R) => {
      const a = lerp(0.45, 0.72, R())
      const bulb = lerp(0.24, 0.38, R())
      const w = lerp(0.22, 0.42, R())
      const f = lerp(0.45, 0.78, R())
      return { r: pchip([0, bulb, 0.72, 1], [a, 1, w, f]), aspect: [1.6, 2.6] }
    },
  },
  hourglass: {
    names: ['hourglass', 'pepper pot', 'cinched vase'],
    make: (R) => {
      const m = lerp(0.36, 0.64, R())
      const w = lerp(0.26, 0.5, R())
      return { r: pchip([0, m, 1], [1, w, 1]), aspect: [1.8, 2.8] }
    },
  },
  bottle: {
    names: ['milk bottle', 'juice bottle', 'syrup jug'],
    make: (R) => {
      const s = lerp(0.38, 0.56, R())
      const n = lerp(0.3, 0.46, R())
      return { r: pchip([0, s, Math.min(0.9, s + 0.22), 1], [1, 1, n, n]), aspect: [1.9, 2.8] }
    },
  },
  tulip: {
    names: ['tulip glass', 'thistle glass', 'milkshake glass'],
    make: (R) => {
      const b = lerp(0.22, 0.42, R())
      const at = lerp(0.36, 0.56, R())
      const rim = lerp(0.62, 0.84, R())
      return { r: pchip([0, at, 1], [b, 1, rim]), aspect: [1.4, 2.4] }
    },
  },
  bell: {
    names: ['bell jar', 'cake dome', 'beehive'],
    make: (R) => {
      const q = lerp(0.75, 0.94, R())
      return { r: (y) => Math.sqrt(1 - y * y * q), aspect: [1.0, 1.7] }
    },
  },
}

export const FAMILY_ORDER = Object.keys(FAMILIES) as Family[]

export type Glass = {
  family: Family
  /** What it's called in play. */
  name: string
  /** Inside radii at the 51 knots, bottom to rim, 0..1000 of the widest. */
  r: number[]
  /** Inside height over the widest radius. */
  aspect: number
  /** Volume below each knot, in frustum units (radii², times π·dy/3). */
  cumV: number[]
  /** Silhouette area below each knot, in trapezoid units (radii, times dy/2). */
  cumA: number[]
  volUnits: number
  /** The true half line, as a (fractional) level. */
  half: number
}

export function buildGlass(family: Family, rng: Rng): Glass {
  const fam = FAMILIES[family]
  const made = fam.make(rng)
  const raw: number[] = []
  let max = 0
  for (let k = 0; k <= K; k++) {
    const v = Math.max(0.02, made.r(k / K))
    raw.push(v)
    if (v > max) max = v
  }
  const r = raw.map((v) => Math.max(20, Math.round((1000 * v) / max)))
  const aspect = Math.round(100 * lerp(made.aspect[0], made.aspect[1], rng())) / 100
  const name = fam.names[Math.floor(rng() * fam.names.length)]!
  return withMeasures(family, name, r, aspect)
}

function withMeasures(family: Family, name: string, r: number[], aspect: number): Glass {
  const cumV = [0]
  const cumA = [0]
  for (let k = 0; k < K; k++) {
    cumV.push(cumV[k]! + (r[k]! * r[k]! + r[k]! * r[k + 1]! + r[k + 1]! * r[k + 1]!))
    cumA.push(cumA[k]! + (r[k]! + r[k + 1]!))
  }
  const g: Glass = { family, name, r, aspect, cumV, cumA, volUnits: cumV[K]!, half: 0 }
  g.half = levelForFrac(g, 0.5)
  return g
}

/** The radius (0..1000) at a level, between the knots. */
export function radiusAt(g: Glass, L: number): number {
  if (L <= 0) return g.r[0]!
  if (L >= LEVELS) return g.r[K]!
  const k = Math.floor(L / PER_SEG)
  const u = (L - k * PER_SEG) / PER_SEG
  return g.r[k]! + (g.r[k + 1]! - g.r[k]!) * u
}

/** Volume below a level, in the units of cumV. */
export function volAt(g: Glass, L: number): number {
  if (L <= 0) return 0
  if (L >= LEVELS) return g.cumV[K]!
  const k = Math.floor(L / PER_SEG)
  const u = (L - k * PER_SEG) / PER_SEG
  const r0 = g.r[k]!
  const ru = r0 + (g.r[k + 1]! - r0) * u
  return g.cumV[k]! + u * (r0 * r0 + r0 * ru + ru * ru)
}

/** Silhouette area below a level, in the units of cumA. */
export function areaAt(g: Glass, L: number): number {
  if (L <= 0) return 0
  if (L >= LEVELS) return g.cumA[K]!
  const k = Math.floor(L / PER_SEG)
  const u = (L - k * PER_SEG) / PER_SEG
  const r0 = g.r[k]!
  const ru = r0 + (g.r[k + 1]! - r0) * u
  return g.cumA[k]! + u * (r0 + ru)
}

/** How full the glass is at a level, 0..1, by what it holds. */
export const frac = (g: Glass, L: number) => volAt(g, L) / g.volUnits
/** How much of the glass's outline is below a level, 0..1: what the eye half goes by. */
export const areaFrac = (g: Glass, L: number) => areaAt(g, L) / g.cumA[K]!

/** The level (fractional) a glass is `f` full at. */
export function levelForFrac(g: Glass, f: number): number {
  let lo = 0
  let hi = LEVELS
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (frac(g, mid) < f) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** What a glass holds below a level, drawn with its widest radius `size` (height = aspect × size). */
export function absVolume(g: Glass, size: number, L: number): number {
  const H = g.aspect * size
  return (Math.PI / 3) * (H / K) * (size / 1000) * (size / 1000) * volAt(g, L)
}

export function absArea(g: Glass, size: number, L: number): number {
  const H = g.aspect * size
  return (H / K) * (size / 1000) * areaAt(g, L)
}

/** The level (fractional) at which a glass drawn at `size` holds V. */
export function levelForAbsVol(g: Glass, size: number, V: number): number {
  let lo = 0
  let hi = LEVELS
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (absVolume(g, size, mid) < V) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
