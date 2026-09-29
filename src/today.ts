import { and, eq, gte, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { dailyHoleResults, leaderboardScores, prizesOwned, ticketLedger } from './db/schema.js'
import { HALFFULL_TODAY_FROM } from './halffull/launch.js'
import { namesOwnedByAccount } from './names.js'
import { notify } from './notifications.js'
import { DAILY_SINCE, boardDateKey, previousBoardDateKey, type GameSlug } from './store.js'
import { awardTickets } from './tickets.js'

/*
 * The Today set: the day's dailies on one punch card, and a streak of the days an account kept. The dailies
 * are Ace Chase's Today's Hole (a result in daily_hole_results), Hot Lap's Today's Track (a lap on the day's
 * board), Find the Bug's Today's Wanted (the day's first run, on its board) and, from the days they join,
 * Half Full's Today's Pour (the day's first run, on its board; halffull/launch.ts HALFFULL_TODAY_FROM) and
 * Marble Run's Today's Course (a run on the day's board; MARBLERUN_TODAY_FROM below). A
 * day is kept once any three of that day's dailies are done (TODAY_KEEP), so every day from before the pour
 * joined still needs all three it had. A day with more than three on the card and every one of them done
 * is a Full ticket. todayRule says which dailies are on a day's card and how many keep it; nothing else
 * decides a day. A day is the boards' day, New York time. The Daily, the One Shot and the bug hunt are the
 * card's bonus punches and don't count.
 *
 * The streak earns looks at milestones, once an account however often it breaks: tickets, the Today pin
 * (flair.ts reads the best streak), the gilded badge finish and the "Every Day" title (prizes.ts: earned,
 * never for sale). The site draws the card from GET /today (todayRoutes.ts) and keeps the same rule and
 * milestones (its lib/today.ts).
 */

export type TodayKey = 'hole' | 'track' | 'wanted' | 'pour' | 'course'

/** How many of a day's dailies keep it. A day with this many or fewer on the card needs every one. */
export const TODAY_KEEP = 3

const keyOf = (day: string) => Number(day.replace(/-/g, ''))

/**
 * The first day Marble Run's Today's Course is on the card: the day after the game came, so the day it came
 * is judged as it began (the site's games/marblerun/daily.ts TODAY_FROM says the same).
 */
export const MARBLERUN_TODAY_FROM: string | null = '2026-09-30'

/**
 * The Today set's dailies, in the card's order, and the first board day (YYYYMMDD) each is on the card: 0
 * for from the start, null for not yet. The first three have been on it from the start, so no day before
 * the pour joined is judged differently.
 */
export const TODAY_DAILIES: readonly { key: TodayKey; game: GameSlug; from: number | null }[] = [
  { key: 'hole', game: 'acechase', from: 0 },
  { key: 'track', game: 'hotlap', from: 0 },
  { key: 'wanted', game: 'findbug', from: 0 },
  { key: 'pour', game: 'halffull', from: HALFFULL_TODAY_FROM ? keyOf(HALFFULL_TODAY_FROM) : null },
  { key: 'course', game: 'marblerun', from: MARBLERUN_TODAY_FROM ? keyOf(MARBLERUN_TODAY_FROM) : null },
]

/** A day's card: the dailies on it (live), in order, and how many of them keep the day. */
export function todayRule(dayKey: number): { live: TodayKey[]; need: number } {
  const live = TODAY_DAILIES.filter((d) => d.from != null && d.from <= dayKey).map((d) => d.key)
  return { live, need: Math.min(TODAY_KEEP, live.length) }
}

/** Whether a day was kept: at least as many of its card's dailies done as keep it. */
export function keptDay(done: ReadonlySet<TodayKey>, dayKey: number): boolean {
  const { live, need } = todayRule(dayKey)
  return live.filter((key) => done.has(key)).length >= need
}

/** Whether a day was a Full ticket: more dailies on its card than keep it, and every one of them done. */
export function fullDay(done: ReadonlySet<TodayKey>, dayKey: number): boolean {
  const { live } = todayRule(dayKey)
  return live.length > TODAY_KEEP && live.every((key) => done.has(key))
}

/** What was done of each daily, day by day: board day key → the day's result. */
export type TodayPlayed = Record<TodayKey, ReadonlyMap<number, number>>

/** The dailies done on a day. */
function doneOn(played: TodayPlayed, dayKey: number): Set<TodayKey> {
  return new Set(TODAY_DAILIES.filter((d) => played[d.key].has(dayKey)).map((d) => d.key))
}

/** The days kept, of every day anything was done. */
export function keptDays(played: TodayPlayed): Set<number> {
  const days = new Set(TODAY_DAILIES.flatMap((d) => [...played[d.key].keys()]))
  return new Set([...days].filter((day) => keptDay(doneOn(played, day), day)))
}

export type TodayMilestone =
  | { day: number; kind: 'tickets'; amount: number }
  | { day: number; kind: 'pin'; id: 'today' }
  | { day: number; kind: 'prize'; id: string }

export const TODAY_MILESTONES: readonly TodayMilestone[] = [
  { day: 3, kind: 'tickets', amount: 10 },
  { day: 7, kind: 'pin', id: 'today' },
  { day: 14, kind: 'tickets', amount: 25 },
  { day: 30, kind: 'prize', id: 'gilded' },
  { day: 100, kind: 'prize', id: 't-everyday' },
]

/** How far back a streak is looked for. */
const LOOKBACK_DAYS = 400
/** The week strip under the streak: this many days, ending today. */
const WEEK_DAYS = 7
/** The Today page's calendar of kept days: five weeks of days, ending today. */
const CALENDAR_DAYS = 35

/**
 * The first board day the Today set could be kept: the day the last of the dailies on its card from the
 * start became a day's game (store.ts DAILY_SINCE), which was Find the Bug's Today's Wanted #1 on
 * 2026-09-27. A day before it wasn't missed; there was nothing to keep.
 */
const TODAY_SINCE = Math.max(...TODAY_DAILIES.filter((d) => d.from === 0).map((d) => DAILY_SINCE[d.game] ?? 0))

export type TodayState = {
  /** The boards' day, YYYY-MM-DD. */
  day: string
  /** Which dailies are done today, on the card or not yet on it (`live` says which count). */
  done: Record<TodayKey, boolean>
  /** Today's results, as the boards keep them: tries, and board scores for the lap and the runs. */
  results: {
    hole: { tries: number } | null
    track: { score: number } | null
    wanted: { score: number } | null
    pour: { score: number } | null
    course: { score: number } | null
  }
  /** Today's card (todayRule): its dailies in order, how many of them keep the day, and how many there are. */
  live: TodayKey[]
  need: number
  count: number
  /** Whether today is a Full ticket (fullDay). */
  full: boolean
  streak: { current: number; best: number }
  /** The last seven days, oldest first, ending today: whether each was a streak day, and a Full ticket. */
  week: { day: string; kept: boolean; full: boolean }[]
  /** The same for the last 35 days, the Today page's calendar; `week` is its last seven, kept for older sites. */
  days: { day: string; kept: boolean; full: boolean }[]
  /** The first day the Today set could be kept (TODAY_SINCE), YYYY-MM-DD: days before it are blank, not missed. */
  since: string
}

const dayOf = (key: number) => {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** What an account has done of the dailies, day by day, over the lookback. */
async function playedDays(accountId: string, now: number): Promise<Record<TodayKey, Map<number, number>>> {
  const fromMs = now - LOOKBACK_DAYS * 86_400_000
  const fromDay = dayOf(boardDateKey(fromMs))
  const tags = (await namesOwnedByAccount(accountId)).map((t) => t.name)
  const runs = (game: 'hotlap' | 'findbug' | 'halffull' | 'marblerun') =>
    tags.length
      ? db()
          .select({ score: leaderboardScores.score, at: leaderboardScores.at })
          .from(leaderboardScores)
          .where(and(eq(leaderboardScores.game, game), inArray(leaderboardScores.name, tags), gte(leaderboardScores.at, fromMs)))
      : Promise.resolve([] as { score: number; at: number }[])
  const [holes, laps, finds, pours, courses] = await Promise.all([
    db()
      .select({ day: dailyHoleResults.day, tries: dailyHoleResults.tries })
      .from(dailyHoleResults)
      .where(and(eq(dailyHoleResults.accountId, accountId), gte(dailyHoleResults.day, fromDay))),
    runs('hotlap'),
    runs('findbug'),
    runs('halffull'),
    runs('marblerun'),
  ])
  const played: Record<TodayKey, Map<number, number>> = { hole: new Map(), track: new Map(), wanted: new Map(), pour: new Map(), course: new Map() }
  for (const h of holes) played.hole.set(keyOf(h.day), h.tries)
  // A lap's board score is higher the faster it was: the day's best is its highest.
  for (const lap of laps) {
    const key = boardDateKey(lap.at)
    played.track.set(key, Math.max(played.track.get(key) ?? 0, lap.score))
  }
  // Since it became a daily, Find the Bug takes only the day's first run (firstRun.ts), so every row of
  // it is a day played; before that it was an endless hunt, whose rows aren't days.
  for (const run of finds) {
    const key = boardDateKey(run.at)
    if (key < (DAILY_SINCE.findbug ?? 0)) continue
    played.wanted.set(key, Math.max(played.wanted.get(key) ?? 0, run.score))
  }
  // Half Full takes only the day's first run too, so its rows are its days, from Half Full #1.
  for (const run of pours) {
    const key = boardDateKey(run.at)
    if (key < (DAILY_SINCE.halffull ?? 0)) continue
    played.pour.set(key, Math.max(played.pour.get(key) ?? 0, run.score))
  }
  // A run down the day's course, as a lap is: the day's best is its highest board score, from course #1.
  for (const run of courses) {
    const key = boardDateKey(run.at)
    if (key < (DAILY_SINCE.marblerun ?? 0)) continue
    played.course.set(key, Math.max(played.course.get(key) ?? 0, run.score))
  }
  return played
}

/** The current streak (from today once it's kept, else from yesterday) and the best one. */
function streaksOf(kept: ReadonlySet<number>, today: number): { current: number; best: number } {
  let current = 0
  for (let day = kept.has(today) ? today : previousBoardDateKey(today); kept.has(day); day = previousBoardDateKey(day)) current++
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const day of [...kept].sort((a, b) => a - b)) {
    run = prev != null && previousBoardDateKey(day) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return { current, best: Math.max(best, current) }
}

export async function todayState(accountId: string, now = Date.now()): Promise<TodayState> {
  const today = boardDateKey(now)
  const played = await playedDays(accountId, now)
  const kept = keptDays(played)
  const days: TodayState['days'] = []
  for (let i = 0, key = today; i < CALENDAR_DAYS; i++, key = previousBoardDateKey(key)) {
    days.unshift({ day: dayOf(key), kept: kept.has(key), full: fullDay(doneOn(played, key), key) })
  }
  const { live, need } = todayRule(today)
  const lap = played.track.get(today)
  const find = played.wanted.get(today)
  const pour = played.pour.get(today)
  const course = played.course.get(today)
  return {
    day: dayOf(today),
    done: {
      hole: played.hole.has(today),
      track: played.track.has(today),
      wanted: played.wanted.has(today),
      pour: played.pour.has(today),
      course: played.course.has(today),
    },
    results: {
      hole: played.hole.has(today) ? { tries: played.hole.get(today)! } : null,
      track: lap != null ? { score: lap } : null,
      wanted: find ? { score: find } : null,
      pour: pour != null ? { score: pour } : null,
      course: course != null ? { score: course } : null,
    },
    live,
    need,
    count: live.length,
    full: fullDay(doneOn(played, today), today),
    streak: streaksOf(kept, today),
    week: days.slice(-WEEK_DAYS),
    days,
    since: dayOf(TODAY_SINCE),
  }
}

/** An account's best Today streak, for the Today pin (flair.ts). */
export async function bestTodayStreak(accountId: string, now = Date.now()): Promise<number> {
  return (await todayState(accountId, now)).streak.best
}

const MILESTONE_WORDS: Record<number, { title: string; body: string; href: string }> = {
  3: { title: 'Day 3 of your Today streak', body: '10 tickets for the prize counter.', href: '/prizes' },
  7: { title: 'A week of Todays', body: 'The Today pin is yours to wear on your badge.', href: '/rank/all' },
  14: { title: 'Day 14 of your Today streak', body: '25 tickets for the prize counter.', href: '/prizes' },
  30: { title: 'Thirty days of Todays', body: 'The gold badge finish is yours to wear.', href: '/rank/all' },
  100: { title: 'A hundred days of Todays', body: 'The “Every Day” title is yours, under your tag.', href: '/rank/all' },
}

/**
 * Pay whatever an account's best streak has reached and not been paid, once each, and say so in its
 * inbox. A milestone is marked paid in the ticket ledger (reason 'today', ref `streak-<day>`), with the
 * tickets it pays or none. Returns the day's state.
 */
export async function settleToday(accountId: string, now = Date.now()): Promise<TodayState> {
  const state = await todayState(accountId, now)
  const due = TODAY_MILESTONES.filter((m) => state.streak.best >= m.day)
  if (!due.length) return state
  const paid = new Set(
    (
      await db()
        .select({ ref: ticketLedger.ref })
        .from(ticketLedger)
        .where(and(eq(ticketLedger.accountId, accountId), eq(ticketLedger.reason, 'today')))
    ).map((row) => row.ref),
  )
  for (const m of due) {
    const ref = `streak-${m.day}`
    if (paid.has(ref)) continue
    if (m.kind === 'prize') {
      await db().insert(prizesOwned).values({ accountId, prizeId: m.id, price: 0, at: now }).onConflictDoNothing()
    }
    const { earned } = await awardTickets(accountId, 'today', ref, m.kind === 'tickets' ? m.amount : 0, null, now)
    const words = MILESTONE_WORDS[m.day]
    if (words && (earned > 0 || m.kind !== 'tickets')) {
      await notify({
        accountId,
        kind: 'trophy',
        title: words.title,
        body: words.body,
        href: words.href,
        meta: m.kind === 'pin' ? { pin: m.id } : {},
        digestKey: `today:${ref}`,
        once: true,
        now,
      }).catch(() => undefined)
    }
  }
  return state
}
