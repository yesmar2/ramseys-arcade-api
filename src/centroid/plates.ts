/*
 * A copy of the site's src/games/dead-center/plates.ts (ramseys-arcade), kept identical but for its imports, so the API deals the
 * same day of plates and scores six taps to the same figure. Change both together (scripts/copy-centroid.py);
 * `npm run check:centroid` compares them day by day.
 */

/*
 * Centroid's plates: their shapes, how they're made, and the geometry that says where each balances. Pure
 * arithmetic and nothing else, so the daily's plan (plan.ts) can deal a day's plates from a seed, and the
 * API can deal the same day again to check a score (its src/centroid holds a byte copy; `npm run
 * check:centroid` there compares them). The arcade game (game.ts) deals from Math.random.
 *
 * Everything is in the table's own units: the plates live in a unit square, and a miss is measured in
 * plate sizes (the square root of a plate's area).
 */

export type Point = { x: number; y: number }

/*
 * Plates used to carry brass weights from the fifth on, pulling the balance
 * point toward them. Ramsey didn't like them ("i don't like the weights being
 * added"), so every plate is plain glass again: its shape alone says where it
 * balances.
 */
export type PlateKind = 'plain' | 'lopsided' | 'notched' | 'elbow'

export type Plate = {
  kind: PlateKind
  points: Point[]
  /** Its balance point. */
  centroid: Point
  /** The square root of its area: what a miss is measured in. */
  size: number
  hue: number
}

/** The margin for a balance on the nth plate, in plate sizes: a fair eye's worth at first, tight later. */
export function marginFor(n: number) {
  return Math.max(0.03, 0.08 - 0.0017 * (n - 1))
}


/** Where the plate maker draws its numbers from: Math.random, or a day's seeded stream (see makePlate). */
let rng: () => number = Math.random

function rand(a: number, b: number) {
  return a + rng() * (b - a)
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Area centroid (shoelace): the balance point of any simple polygon. */
export function polygonCentroid(pts: Point[]): Point {
  const n = pts.length
  let area2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    const cross = a.x * b.y - b.x * a.y
    area2 += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  if (Math.abs(area2) < 1e-12) {
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n }
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) }
}

export function polygonArea(pts: Point[]) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % pts.length]!
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/** Whether a point is on the plate (an even-odd count of crossings). */
export function onPlate(pts: Point[], p: Point): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!
    const b = pts[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function nearestOnEdge(pts: Point[], p: Point) {
  let best = p
  let bestD = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    const abx = b.x - a.x
    const aby = b.y - a.y
    const u = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1), 0, 1)
    const q = { x: a.x + abx * u, y: a.y + aby * u }
    const d = dist(p, q)
    if (d < bestD) {
      bestD = d
      best = q
    }
  }
  return { at: best, d: bestD }
}

/** Where a pin aimed at `p` goes in: there, or if that's off the plate, just inside its nearest edge. */
export function pinPoint(plate: Plate, p: Point): Point {
  if (onPlate(plate.points, p)) return p
  const { at } = nearestOnEdge(plate.points, p)
  const c = plate.centroid
  const d = dist(at, c) || 1
  return { x: at.x + ((c.x - at.x) / d) * 0.006, y: at.y + ((c.y - at.y) / d) * 0.006 }
}




/** The site's own colours for the plates, clear of the gold the balance point is marked in and the pin's red. */
export const PLATE_HUES = [204, 183, 153, 262, 289, 236, 334, 23] as const

export function convexHull(pts: Point[]): Point[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/**
 * A convex plate: corners scattered round an ellipse at uneven reach, wrapped.
 * `pull` draws some corners in hard, which moves the balance point away from
 * where the eye puts the middle.
 */
function convexPlate(corners: number, pull: number): Point[] {
  const rx = rand(0.26, 0.44)
  const ry = rand(0.17, 0.36)
  const rot = rand(0, Math.PI)
  const start = rand(0, Math.PI * 2)
  const pts: Point[] = []
  for (let i = 0; i < corners; i++) {
    const a = start + ((i + rand(-0.38, 0.38)) / corners) * Math.PI * 2
    const r = 1 - pull * rng() * (i % 2 ? 1 : 0.5)
    const x = Math.cos(a) * rx * r
    const y = Math.sin(a) * ry * r
    pts.push({ x: x * Math.cos(rot) - y * Math.sin(rot), y: x * Math.sin(rot) + y * Math.cos(rot) })
  }
  return convexHull(pts)
}

/** A convex plate with a bite out of one side: the balance point runs away from the bite. */
function notchedPlate(): Point[] {
  const base = convexPlate(Math.floor(rand(4, 7)), 0.2)
  const i = Math.floor(rng() * base.length)
  const a = base[i]!
  const b = base[(i + 1) % base.length]!
  const c = polygonCentroid(base)
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const depth = rand(0.4, 0.75)
  const width = rand(0.3, 0.55)
  // The bite's floor is a little wide too, so it reads as a cut, not a crack.
  const inward = { x: (c.x - mid.x) * depth, y: (c.y - mid.y) * depth }
  const p1 = { x: mid.x + (a.x - mid.x) * width, y: mid.y + (a.y - mid.y) * width }
  const p2 = { x: mid.x + (b.x - mid.x) * width, y: mid.y + (b.y - mid.y) * width }
  const q1 = { x: mid.x + (a.x - mid.x) * width * 0.35 + inward.x, y: mid.y + (a.y - mid.y) * width * 0.35 + inward.y }
  const q2 = { x: mid.x + (b.x - mid.x) * width * 0.35 + inward.x, y: mid.y + (b.y - mid.y) * width * 0.35 + inward.y }
  const out: Point[] = []
  for (let k = 0; k < base.length; k++) {
    out.push(base[k]!)
    if (k === i) out.push(p1, q1, q2, p2)
  }
  return out
}

/**
 * An L: two limbs set at a corner, a little off square, fat enough that its
 * balance point, which sits toward the inside of the bend, is on the plate.
 */
function elbowPlate(): Point[] {
  const w = rand(0.2, 0.26)
  const a = rand(0.38, 0.54)
  const b = rand(0.34, 0.5)
  const shear = rand(-0.3, 0.3)
  const rot = rand(0, Math.PI * 2)
  const local: Point[] = [
    { x: 0, y: 0 },
    { x: a, y: 0 },
    { x: a, y: w },
    { x: w, y: w },
    { x: w, y: b },
    { x: 0, y: b },
  ]
  return local.map((p) => {
    const x = p.x + shear * p.y
    return { x: x * Math.cos(rot) - p.y * Math.sin(rot), y: x * Math.sin(rot) + p.y * Math.cos(rot) }
  })
}

export function box(pts: Point[]) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x0, y0, x1, y1 }
}

/** Scaled to the size asked for (or less, to fit), and set on the table a little off its middle, never twice in the same spot. */
function placeOnTable(pts: Point[], target: number): Point[] {
  const size = Math.sqrt(polygonArea(pts)) || 1
  const b = box(pts)
  const k = Math.min(target / size, 0.84 / Math.max(1e-6, b.x1 - b.x0), 0.8 / Math.max(1e-6, b.y1 - b.y0))
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  const halfW = ((b.x1 - b.x0) * k) / 2
  const halfH = ((b.y1 - b.y0) * k) / 2
  // As far off the middle as there is room for, up to a little.
  const mx = clamp(0.5 + rand(-0.08, 0.08), 0.08 + halfW, 0.92 - halfW)
  const my = clamp(0.5 + rand(-0.07, 0.07), 0.1 + halfH, 0.9 - halfH)
  return pts.map((p) => ({ x: mx + (p.x - cx) * k, y: my + (p.y - cy) * k }))
}

/**
 * How far the balance point is from the middle of the plate's box, in plate
 * sizes: where an eye that doesn't weigh the plate would put the pin.
 */
export function deception(plate: Plate) {
  const b = box(plate.points)
  return Math.hypot(plate.centroid.x - (b.x0 + b.x1) / 2, plate.centroid.y - (b.y0 + b.y1) / 2) / plate.size
}

/**
 * What the nth plate is. The first two are plain and fair, to learn on. From
 * the third, more and more are lopsided, their balance point well away from
 * the middle of their box; from the fourth some are Ls, whose balance point
 * sits toward the inside of the bend; from the seventh some have a bite
 * taken out. By the tenth nearly every plate is one to think about.
 */
function familyFor(n: number): PlateKind {
  if (n <= 2) return 'plain'
  const elbow = n >= 4 ? Math.min(0.18, 0.08 + (n - 4) * 0.012) : 0
  const notched = n >= 7 ? Math.min(0.2, 0.08 + (n - 7) * 0.015) : 0
  const r = rng()
  if (r < elbow) return 'elbow'
  if (r < elbow + notched) return 'notched'
  return rng() < clamp((n - 2) / 8, 0, 0.85) ? 'lopsided' : 'plain'
}

/**
 * The nth plate, in `hue`, drawn from `random` (Math.random for a run of the arcade game; a day's seeded
 * stream for the daily, plan.ts, so everyone gets the same plates and the API can build them again).
 */
export function makePlate(n: number, hue: number = PLATE_HUES[n % PLATE_HUES.length]!, random: () => number = Math.random, tricky = 0): Plate {
  const was = rng
  rng = random
  try {
    return makePlateNow(n, hue, tricky)
  } finally {
    rng = was
  }
}

/**
 * `tricky` (the daily's, since 2026-10-07): never a plain plate, Ls and bitten plates far more often, and
 * every plate's balance point at least this far from the middle of its box, in plate sizes, so the eye that
 * pins the middle is fooled by that much. 0 is the arcade's plates.
 */
function makePlateNow(n: number, hue: number, tricky: number): Plate {
  const margin = marginFor(n)
  let kind = familyFor(n)
  if (tricky > 0) {
    const r = rng()
    kind = r < 0.3 ? 'elbow' : r < 0.58 ? 'notched' : 'lopsided'
  }
  let best: Plate | null = null
  let bestScore = -Infinity
  for (let tries = 0; tries < (tricky > 0 ? 160 : 50); tries++) {
    const corners = Math.floor(rand(3, n <= 2 ? 6 : 8))
    const raw =
      kind === 'notched'
        ? notchedPlate()
        : kind === 'elbow'
          ? elbowPlate()
          : convexPlate(corners, kind === 'lopsided' ? rand(0.35, 0.65) : rand(0.05, 0.3))
    if (raw.length < 3) continue
    const points = placeOnTable(raw, rand(0.46, 0.64))
    const area = polygonArea(points)
    if (area < 0.11) continue
    const centroid = polygonCentroid(points)
    // The pin has to be able to go in at the balance point, clear of the edge.
    const room = kind === 'elbow' ? 0.05 : 0.07
    if (!onPlate(points, centroid) || nearestOnEdge(points, centroid).d < room) continue
    const plate: Plate = { kind, points, centroid, size: Math.sqrt(area), hue }
    // A plain plate should be plainly fair; a lopsided one should fool a pin in the middle of its box.
    const fooled = deception(plate)
    const want = Math.max(kind === 'plain' ? -margin * 0.9 : kind === 'lopsided' ? margin * 1.15 : 0, tricky)
    const score = kind === 'plain' ? -fooled : fooled
    if (score >= want) return plate
    if (score > bestScore) {
      bestScore = score
      best = plate
    }
  }
  if (best) return best
  const points = placeOnTable(convexPlate(4, 0.1), 0.55)
  return { kind: 'plain', points, centroid: polygonCentroid(points), size: Math.sqrt(polygonArea(points)), hue }
}
