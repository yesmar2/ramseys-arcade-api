/*
 * A copy of the site's src/games/dead-center/score.ts (ramseys-arcade), kept identical but for its imports, so the API deals the
 * same day of plates and scores six taps to the same figure. Change both together (scripts/copy-centroid.py);
 * `npm run check:centroid` compares them day by day.
 */

import { boardScore } from './boardFigure.js'
import { PLATES, type DayPlan } from './plan.js'
import { pinPoint, type Plate, type Point } from './plates.js'

/*
 * Centroid's daily scoring. A plate is judged by how far the pin went in from its true balance point, in
 * plate sizes (the square root of its area), taken to a tenth of a percent: dead on scores 100, and every
 * percent off costs 3 (2% off is 94, 10% off is 70). The day is the mean of the six, and the board keeps it
 * in hundredths (9340 is 93.4%), as Half Full's does.
 *
 * Everything a player sees is worked from that one figure: the points, the words and the square agree.
 */

/** Within this share of its size the pin holds the plate up; further off, it tips. */
export const DAILY_MARGIN = 0.05

/** How far off the balance point a tap's pin went in, in plate sizes. */
export function offOf(plate: Plate, tap: Point): number {
  const pin = pinPoint(plate, tap)
  return Math.hypot(pin.x - plate.centroid.x, pin.y - plate.centroid.y) / plate.size
}

/** How far off, in percent of the plate's size, to a tenth. */
export function offPercent(off: number): number {
  return Math.round(1000 * off) / 10
}

/** A plate's score: 100 dead on, less 3 for every percent off, to a tenth. */
export function plateScore(off: number): number {
  return Math.max(0, Math.round(10 * (100 - 3 * offPercent(off))) / 10)
}

/** The day's score, the mean of its plates. */
export function dayScore(scores: readonly number[]): number {
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
}

export { boardScore, formatBoard } from './boardFigure.js'

/** The day to a tenth, rounded down, as it's shown and as its tier is judged. */
export function dayTenths(day: number): number {
  return Math.floor(10 * day + 1e-6) / 10
}

/** "93.4%" */
export function formatScore(day: number): string {
  return `${dayTenths(day).toFixed(1)}%`
}

export type Tier = 'Dead Center' | 'Steady' | 'Wobbly' | 'Tipsy' | 'Toppled'

export function tierFor(day: number): Tier {
  day = dayTenths(day)
  if (day >= 95) return 'Dead Center'
  if (day >= 90) return 'Steady'
  if (day >= 82) return 'Wobbly'
  if (day >= 70) return 'Tipsy'
  return 'Toppled'
}

export type Mark = '🎯' | '🟩' | '🟨' | '🟧' | '🟥'

/** A plate as a square: within 1% of its size, 3%, 6%, 10%, or further off. */
export function markFor(score: number): Mark {
  if (score >= 97) return '🎯'
  if (score >= 91) return '🟩'
  if (score >= 82) return '🟨'
  if (score >= 70) return '🟧'
  return '🟥'
}

/** A plate's points: "100", "94.3". */
export function formatPoints(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

/* ---------- a day's six taps, judged ---------- */

/** Whether taps could be a run of a day: six points on the table (it's a unit square, give or take an edge). */
export function tapsFit(taps: readonly unknown[]): taps is Point[] {
  if (taps.length !== PLATES) return false
  return taps.every((t) => {
    if (!t || typeof t !== 'object') return false
    const { x, y } = t as Point
    return Number.isFinite(x) && Number.isFinite(y) && x >= -0.1 && x <= 1.1 && y >= -0.1 && y <= 1.1
  })
}

export type JudgedDay = {
  /** How far off each pin went in, in plate sizes. */
  offs: number[]
  /** Each plate's points, 0..100. */
  scores: number[]
  /** The day's score, their mean. */
  day: number
  /** The board's figure (boardScore). */
  board: number
}

/** A day's result from its six taps: the site's run and the API's check work it out the same way. */
export function judgeTaps(plan: DayPlan, taps: readonly Point[]): JudgedDay {
  const offs = taps.map((tap, i) => offOf(plan.plates[i]!, tap))
  const scores = offs.map(plateScore)
  const day = dayScore(scores)
  return { offs, scores, day, board: boardScore(day) }
}
