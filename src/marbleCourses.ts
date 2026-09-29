import { MARBLERUN_FIRST_DAY } from './marblerunPace.js'
import { boardDateKey, dayPlayers, type DeviceType } from './store.js'

/*
 * Marble Run's courses. Course n is day n's, from the first day (the site's games/marblerun/daily.ts
 * courseNumber), and a course has its day's board and no other: after its day it's rolled as practice,
 * kept nowhere, so the board its day closed with is its board for good.
 */

const FIRST = (() => {
  const [y, m, d] = MARBLERUN_FIRST_DAY.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
})()

/** Far past any plan: a number no course will have. */
const MOST_COURSES = 100_000

const dayUtc = (key: number) => Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100)

/** A board day's course: 1 on the first day. */
export function courseOfDay(key: number): number {
  return Math.round((dayUtc(key) - FIRST) / 86_400_000) + 1
}

/** A course's board day (YYYYMMDD). */
export function courseDayKey(n: number): number {
  const at = new Date(FIRST + (n - 1) * 86_400_000)
  return at.getUTCFullYear() * 10_000 + (at.getUTCMonth() + 1) * 100 + at.getUTCDate()
}

/**
 * Where a course stands today: 'today' while it's the Daily, 'past' once its day has gone, 'ahead' before
 * its day, or 'none' for a number no day has.
 */
export function courseState(n: number, now = Date.now()): 'past' | 'today' | 'ahead' | 'none' {
  if (!Number.isInteger(n) || n < 1 || n > MOST_COURSES) return 'none'
  const today = courseOfDay(boardDateKey(now))
  return n === today ? 'today' : n < today ? 'past' : 'ahead'
}

/** A course's board: each player's best run on its day, best first, a tie going to the earlier. */
export async function courseBoard(n: number): Promise<{ name: string; score: number; at: number; device: DeviceType }[]> {
  return dayPlayers('marblerun', courseDayKey(n))
}
