import { LANDER_FIRST_DAY } from './landerPace.js'
import { boardDateKey, dayPlayers, type DeviceType } from './store.js'

/*
 * Lander's caves. Cave n is day n's, from the first day (the site's games/lander/daily.ts caveNumber), and a
 * cave has its day's board and no other: after its day it's flown as practice, kept nowhere, so the board its
 * day closed with is its board for good. As Marble Run's courses are (marbleCourses.ts).
 */

const FIRST = (() => {
  const [y, m, d] = LANDER_FIRST_DAY.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
})()

/** Far past any plan: a number no cave will have. */
const MOST_CAVES = 100_000

const dayUtc = (key: number) => Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100)

/** A board day's cave: 1 on the first day. */
export function caveOfDay(key: number): number {
  return Math.round((dayUtc(key) - FIRST) / 86_400_000) + 1
}

/** A cave's board day (YYYYMMDD). */
export function caveDayKey(n: number): number {
  const at = new Date(FIRST + (n - 1) * 86_400_000)
  return at.getUTCFullYear() * 10_000 + (at.getUTCMonth() + 1) * 100 + at.getUTCDate()
}

/**
 * Where a cave stands today: 'today' while it's the day's, 'past' once its day has gone, 'ahead' before its
 * day, or 'none' for a number no day has.
 */
export function caveState(n: number, now = Date.now()): 'past' | 'today' | 'ahead' | 'none' {
  if (!Number.isInteger(n) || n < 1 || n > MOST_CAVES) return 'none'
  const today = caveOfDay(boardDateKey(now))
  return n === today ? 'today' : n < today ? 'past' : 'ahead'
}

/** A cave's board: each player's best run on its day, best first, a tie going to the earlier. */
export async function caveBoard(n: number): Promise<{ name: string; score: number; at: number; device: DeviceType }[]> {
  return dayPlayers('lander', caveDayKey(n))
}
