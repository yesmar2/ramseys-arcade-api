/*
 * A copy of the site's src/games/dead-center/plan.ts (ramseys-arcade), kept identical but for its imports, so the API deals the
 * same day of plates and scores six taps to the same figure. Change both together (scripts/copy-centroid.py);
 * `npm run check:centroid` compares them day by day.
 */

import { hashString, mulberry32 } from './seededRandom.js'
import { PLATE_HUES, makePlate, polygonArea, polygonCentroid, type Plate } from './plates.js'

/*
 * A day of Centroid: six plates to balance, easy to hard, the same for everyone (Ramsey, 2026-10-06:
 * "centroid should be a daily like the fill the cup game"). It grows from the date alone: the site deals
 * it, and the API deals the same day again to check a score (its src/centroid holds a byte copy of this,
 * plates.ts, score.ts and seededRandom.ts; `npm run check:centroid` there compares them).
 *
 * How hard a day is goes by the weekday, Monday easy to Sunday brutal, as Half Full's does: each of the
 * six is dealt as the arcade game's nth plate would be, and a harder day starts further along, where the
 * plates are lopsided, bent into Ls or bitten, and fool an eye that pins the middle of their box.
 *
 * Every corner is rounded to a millionth once it's dealt, so the last digit a sine or a cosine leaves can't
 * make one engine's plate differ from another's.
 */

/** How many plates a day. */
export const PLATES = 6

export type DayLabel = 'Easy' | 'Medium' | 'Tricky' | 'Hard' | 'Brutal'

/**
 * Which of the arcade game's plates each of the day's six is dealt as, by weekday (0 = Sunday). Two further
 * along than at first since Ramsey's "the plates are a little too easy" (2026-10-07): no plain plates now,
 * and more lopsided ones, Ls and bites from Monday on.
 */
export const DAY_LEVELS: Record<number, readonly [levels: readonly number[], label: DayLabel]> = {
  1: [[3, 4, 5, 6, 7, 8], 'Easy'],
  2: [[4, 5, 6, 7, 8, 9], 'Easy'],
  3: [[5, 6, 7, 8, 9, 10], 'Medium'],
  4: [[6, 7, 8, 9, 10, 12], 'Medium'],
  5: [[7, 8, 9, 10, 12, 13], 'Tricky'],
  6: [[8, 9, 10, 12, 13, 15], 'Hard'],
  0: [[9, 10, 12, 13, 15, 17], 'Brutal'],
}

/**
 * How far each day's plates must fool an eye that pins the middle of their box, in plate sizes, by weekday:
 * the first plate's, rising a little plate by plate (Ramsey, 2026-10-07: "can we make the shapes a little
 * more difficult?").
 */
export const DAY_DECEIVE: Record<number, number> = { 1: 0.08, 2: 0.09, 3: 0.1, 4: 0.11, 5: 0.12, 6: 0.13, 0: 0.14 }
const DECEIVE_STEP = 0.006

export type DayPlan = {
  day: string
  label: DayLabel
  plates: Plate[]
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/** A plate with its corners rounded to a millionth, and its balance point and size worked out again from them. */
function settled(plate: Plate): Plate {
  const points = plate.points.map((p) => ({ x: round6(p.x), y: round6(p.y) }))
  return { ...plate, points, centroid: polygonCentroid(points), size: Math.sqrt(polygonArea(points)) }
}

const plans = new Map<string, DayPlan>()

/** The day's six plates, YYYY-MM-DD. */
export function dayPlan(day: string): DayPlan {
  const kept = plans.get(day)
  if (kept) return kept
  const rng = mulberry32(hashString(`centroid:${day}`))
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
  const [levels, label] = DAY_LEVELS[weekday]!
  // The day's colours, in an order of its own.
  const hues: number[] = [...PLATE_HUES]
  for (let i = hues.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[hues[i], hues[j]] = [hues[j]!, hues[i]!]
  }
  // None plain: each is lopsided, an L or bitten, so a pin in the middle of its box never does.
  const deceive = DAY_DECEIVE[weekday]!
  const plates = levels.map((n, i) => settled(makePlate(n, hues[i % hues.length]!, rng, deceive + i * DECEIVE_STEP)))
  const plan: DayPlan = { day, label, plates }
  if (plans.size > 60) plans.clear()
  plans.set(day, plan)
  return plan
}
