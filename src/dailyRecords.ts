import { ACECHASE_FIRST_DAY } from './courseNames.js'
import { holeRecords, holeToday } from './holes.js'
import { TRIES_SCORE_BASE, TRIES_SCORED_GAMES } from './scoreLimits.js'
import { boardDateKey, DAILY_SINCE, dailyDays, type GameSlug } from './store.js'
import { dayNumberOf, trackOfDay, trackRecords } from './trackLaps.js'

/*
 * A daily's records of its own, for the Records tab of its page on the site: the ones its boards don't
 * already show. "Days played in a row" is in its record book (records.ts); these two come from the boards.
 *
 *   Days won: the days a player was 1st on the day's board, a tie going to whoever got there first, as
 *   the day's board has it. Only a day that's over counts, from the game's first course, as its past tab
 *   lists them (WON_SINCE: Ace Chase's hole #1; store.ts DAILY_SINCE for the rest), to yesterday: today's
 *   1st is only 1st so far.
 *   Course records held, Hot Lap's tracks and Ace Chase's holes: the past courses whose own board a player
 *   tops (trackLaps.ts, holes.ts). Today's course isn't one yet: its #1 is 1st today.
 *
 * Of two with as many, the one who got there first is ahead, then the name first in the alphabet.
 */

/** Which of a daily's runs are a day's result: not a round of Ace Chase's old three holes, from before it counted tries. */
export function dayResultKeep(game: GameSlug): ((score: number) => boolean) | undefined {
  return TRIES_SCORED_GAMES.has(game) ? (score: number) => score > TRIES_SCORE_BASE - 1000 : undefined
}

/** A player's count on one of these records, and when they got there: their latest day won or record set. */
export type DailyTally = { name: string; count: number; reached: number; courses: number[] }

export type DailyRecords = {
  daysWon: { closedDays: number; ranked: DailyTally[] }
  /** Hot Lap and Ace Chase only. */
  courseRecords: { pastCourses: number; ranked: DailyTally[] } | null
}

const nameOrder = new Intl.Collator()

function ranked(tallies: Iterable<DailyTally>): DailyTally[] {
  return [...tallies].sort((a, b) => b.count - a.count || a.reached - b.reached || nameOrder.compare(a.name, b.name))
}

/**
 * The first day (YYYYMMDD) a daily's days are won from, where it's earlier than its day points (DAILY_SINCE):
 * Ace Chase's hole #1 had its day on Sep 25, two days before its board took Today's Hole, and those days'
 * 1sts show on Past holes. The old three-hole rounds on the board those days are left out by
 * dayResultKeep, so only Today's Hole results count. The rest go by DAILY_SINCE, not from their first run:
 * Find the Bug's endless-hunt day (Sep 23) stays out.
 */
const WON_SINCE: Partial<Record<GameSlug, number>> = {
  acechase: Number(ACECHASE_FIRST_DAY.replace(/-/g, '')),
}

/** Each day that's over and its 1st, into a count a player. */
async function daysWon(game: GameSlug, now: number): Promise<DailyRecords['daysWon']> {
  const since = WON_SINCE[game] ?? DAILY_SINCE[game] ?? 0
  const today = boardDateKey(now)
  const byName = new Map<string, DailyTally>()
  let closedDays = 0
  // Newest first, so a player's first day met is their latest win.
  for (const day of await dailyDays(game, null, dayResultKeep(game))) {
    if (day.day < since || day.day >= today) continue
    closedDays++
    const had = byName.get(day.top.name)
    if (had) had.count++
    else byName.set(day.top.name, { name: day.top.name, count: 1, reached: day.day, courses: [] })
  }
  return { closedDays, ranked: ranked(byName.values()) }
}

/** Each past course's #1, into a count a player, with the courses they hold. */
function held(courses: { n: number; holder: { name: string; at: number } | null }[]): DailyTally[] {
  const byName = new Map<string, DailyTally>()
  for (const { n, holder } of courses) {
    if (!holder) continue
    const had = byName.get(holder.name)
    if (had) {
      had.count++
      had.reached = Math.max(had.reached, holder.at)
      had.courses.push(n)
    } else byName.set(holder.name, { name: holder.name, count: 1, reached: holder.at, courses: [n] })
  }
  for (const tally of byName.values()) tally.courses.sort((a, b) => a - b)
  return ranked(byName.values())
}

async function courseRecords(game: GameSlug, now: number): Promise<DailyRecords['courseRecords']> {
  if (game === 'hotlap') {
    const today = dayNumberOf(boardDateKey(now))
    const todays = today >= 1 ? trackOfDay(today) : null
    const past = (await trackRecords(game, null, now)).filter((t) => t.track !== todays)
    return { pastCourses: past.length, ranked: held(past.map((t) => ({ n: t.track, holder: t.record }))) }
  }
  if (game === 'acechase') {
    const today = holeToday(now)
    const past = (await holeRecords(game, null, now)).filter((h) => h.day < today)
    return { pastCourses: past.length, ranked: held(past.map((h) => ({ n: h.n, holder: h.record }))) }
  }
  return null
}

/*
 * Kept half a minute a game: every player's tab asks the same thing, and a Hot Lap track's list reads each
 * track's board. A day closing or a record changing hands shows within that.
 */
const CACHE_MS = 30_000
const cache = new Map<GameSlug, { at: number; records: Promise<DailyRecords> }>()

export function dailyRecords(game: GameSlug, now = Date.now()): Promise<DailyRecords> {
  const hit = cache.get(game)
  if (hit && now - hit.at < CACHE_MS) return hit.records
  const records = Promise.all([daysWon(game, now), courseRecords(game, now)]).then(([days, courses]) => ({
    daysWon: days,
    courseRecords: courses,
  }))
  cache.set(game, { at: now, records })
  // A failed read isn't kept: the next ask tries again.
  records.catch(() => {
    if (cache.get(game)?.records === records) cache.delete(game)
  })
  return records
}

/** Where a tag stands on one of these: its count, its place, how many others have as many; null with none. */
export function standingOn(tallies: DailyTally[], name: string): { tally: DailyTally; place: number; tied: number } | null {
  const at = tallies.findIndex((t) => t.name === name)
  if (at < 0) return null
  const tally = tallies[at]!
  return { tally, place: at + 1, tied: tallies.filter((t) => t.count === tally.count).length - 1 }
}
