import { ACECHASE_FIRST_DAY } from './courseNames.js'
import { holeRecords, holeToday } from './holes.js'
import { TRIES_SCORE_BASE, TRIES_SCORED_GAMES } from './scoreLimits.js'
import { boardDateKey, DAILY_SINCE, dailyDays, dayBoards, type GameSlug } from './store.js'
import { ladderFor, RACE_MEDAL_STEP } from './ticketLadders.js'
import { dayNumberOf, trackOfDay, trackRecords } from './trackLaps.js'

/*
 * A daily's records of its own, for the Records tab of its page on the site: the ones its boards don't
 * already show. "Days played in a row" is in its record book (records.ts); these come from the boards.
 *
 *   Days won: the days a player was 1st on the day's board, a tie going to whoever got there first, as
 *   the day's board has it. Only a day that's over counts, from the game's first course, as its past tab
 *   lists them (WON_SINCE: Ace Chase's hole #1; store.ts DAILY_SINCE for the rest), to yesterday: today's
 *   1st is only 1st so far. What they're out of is every one of those days, as the past tab lists them too:
 *   a day nobody played is a day nobody won.
 *   Days on the podium: the same, 1st, 2nd or 3rd. Far more players get there than win a day (Ramsey,
 *   2026-10-13: "yes, all of it").
 *   Gold medals in a row: the racing dailies', a gold or platinum on the day's course day after day. A daily's
 *   scores can't be held to one line, each day's course being its own, but its medals go by each day's blue
 *   run (ticketLadders.ts), so a run of them means the same whichever days they were. Today adds to a streak
 *   once it's gold, and only a day that's over ends one.
 *   Course records held, Hot Lap's tracks and Ace Chase's holes: the past courses whose own board a player
 *   tops (trackLaps.ts, holes.ts). Today's course isn't one yet: its #1 is 1st today.
 *
 * Of two with as many, the one who got there first is ahead, then the name first in the alphabet.
 */

/** Which of a daily's runs are a day's result: not a round of Ace Chase's old three holes, from before it counted tries. */
export function dayResultKeep(game: GameSlug): ((score: number) => boolean) | undefined {
  return TRIES_SCORED_GAMES.has(game) ? keepTriesResult : undefined
}

// One function, not one a call: a day's lines are kept per `keep` (store.ts dayLine).
const keepTriesResult = (score: number) => score > TRIES_SCORE_BASE - 1000

/** A player's count on one of these records, and when they got there: their latest day won or record set. */
export type DailyTally = { name: string; count: number; reached: number; courses: number[] }

export type DailyRecords = {
  daysWon: { closedDays: number; ranked: DailyTally[] }
  podiumDays: { closedDays: number; ranked: DailyTally[] }
  /** The racing dailies only: each player's longest run of gold medals, and the day it was reached. */
  goldStreak: { ranked: DailyTally[] } | null
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

/** A daily's first day (YYYYMMDD), its course #1's: the first its past tab lists, and the first with a day's board to show. */
export function dailyFirstDay(game: GameSlug): number {
  return WON_SINCE[game] ?? DAILY_SINCE[game] ?? 0
}

/** A board day's (YYYYMMDD) midnight on the UTC calendar, for counting the days between two. */
function dayUtc(key: number): number {
  return Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100)
}

/** Each day that's over and its 1st, into a count a player. */
async function daysWon(game: GameSlug, now: number): Promise<DailyRecords['daysWon']> {
  const since = dailyFirstDay(game)
  const today = boardDateKey(now)
  const byName = new Map<string, DailyTally>()
  let won = 0
  // Newest first, so a player's first day met is their latest win.
  for (const day of await dailyDays(game, null, dayResultKeep(game))) {
    if (day.day < since || day.day >= today) continue
    won++
    const had = byName.get(day.top.name)
    if (had) had.count++
    else byName.set(day.top.name, { name: day.top.name, count: 1, reached: day.day, courses: [] })
  }
  return { closedDays: daysOver(since, today, won), ranked: ranked(byName.values()) }
}

/** Every day that's over since a daily's first, played or not, as the past tab lists them: at least the days met. */
function daysOver(since: number, today: number, met: number): number {
  return since ? Math.max(met, Math.round((dayUtc(today) - dayUtc(since)) / 86_400_000)) : met
}

/** Each day that's over and its top three, into a count a player: the day they last made it is when they got there. */
async function podiumDays(game: GameSlug, now: number): Promise<DailyRecords['podiumDays']> {
  const since = dailyFirstDay(game)
  const today = boardDateKey(now)
  const byName = new Map<string, DailyTally>()
  let met = 0
  for (const [day, players] of await dayBoards(game)) {
    if (day < since || day >= today || !players.length) continue
    met++
    for (const { name } of players.slice(0, 3)) {
      const had = byName.get(name)
      if (had) {
        had.count++
        had.reached = Math.max(had.reached, day)
      } else byName.set(name, { name, count: 1, reached: day, courses: [] })
    }
  }
  return { closedDays: daysOver(since, today, met), ranked: ranked(byName.values()) }
}

/** The day after a board day (YYYYMMDD), on the calendar. */
function nextDay(key: number): number {
  const d = new Date(dayUtc(key) + 86_400_000)
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** A gold streak's least: one gold day is a day, not a run of them. */
const GOLD_STREAK_MIN = 2

/**
 * Each player's longest run of gold (or platinum) medals on a racing daily's days, one day after another: gold is
 * the third step of the day's ladder, by its blue run. A day they didn't play, or played short of gold, ends a run,
 * once the day is over. Null for a daily without medals.
 */
async function goldStreaks(game: GameSlug, now: number): Promise<DailyRecords['goldStreak']> {
  if (!(game in RACE_MEDAL_STEP)) return null
  const today = boardDateKey(now)
  const boards = await dayBoards(game)
  const going = new Map<string, number>()
  const best = new Map<string, { count: number; reached: number }>()
  for (let day = dailyFirstDay(game); day > 0 && day <= today; day = nextDay(day)) {
    // A moment in the day on the boards' clock (America/New_York), for the ladder its plan gives it.
    const gold = (await ladderFor(game, dayUtc(day) + 16 * 3_600_000)).steps[2]?.at
    const golds = new Set<string>()
    if (gold != null) for (const p of boards.get(day) ?? []) if (p.score >= gold) golds.add(p.name)
    for (const name of golds) {
      const count = (going.get(name) ?? 0) + 1
      going.set(name, count)
      const had = best.get(name)
      if (!had || count > had.count) best.set(name, { count, reached: day })
    }
    // Today's still open: only a day that's over ends a run.
    if (day === today) continue
    for (const name of [...going.keys()]) if (!golds.has(name)) going.delete(name)
  }
  const tallies: DailyTally[] = []
  for (const [name, { count, reached }] of best) if (count >= GOLD_STREAK_MIN) tallies.push({ name, count, reached, courses: [] })
  return { ranked: ranked(tallies) }
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
  const records = Promise.all([daysWon(game, now), podiumDays(game, now), goldStreaks(game, now), courseRecords(game, now)]).then(
    ([days, podium, gold, courses]) => ({
      daysWon: days,
      podiumDays: podium,
      goldStreak: gold,
      courseRecords: courses,
    }),
  )
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
