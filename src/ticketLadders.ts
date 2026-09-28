import { HOTLAP_FIRST_DAY, HOTLAP_PACE_MS } from './hotlapPace.js'
import { TIME_SCORE_BASE, TIME_SCORED_GAMES, TRIES_SCORE_BASE } from './scoreLimits.js'
import { GAME_BANDS } from './seedBoards.js'
import { ALLOWED_GAMES, boardDateKey, runScores, type GameSlug } from './store.js'

/*
 * Ticket ladders: what a run pays by the score it reached, the way an arcade
 * machine pays out. A run pays the same whoever else is playing, and
 * whenever: nothing here looks at the other runs of the day or the week.
 *
 * Most games' ladders are drawn from their own runs: 1 ticket for any run,
 * then 3, 5, 7 and 10 at the scores about half, a quarter, a tenth and the
 * best 3% of all runs reach, rounded to figures that read well. So every game
 * pays about the same for the same skill, and none is the easy one to farm.
 * They're drawn again each day, so they follow players as they get better.
 *
 * The dailies have their own. Ace Chase goes by the tries, since every day's
 * hole is held to the same difficulty. Hot Lap goes by the day's blue car
 * (the pace car), since its track changes every day: the plan's own, kept in
 * hotlapPace.ts, so the site can't say a slower one. A daily pays its best
 * step of the day once, as it's reached (tickets.ts).
 */

export type LadderStep = {
  /** The board score that reaches this step: points, or the base less the time or the tries. */
  at: number
  tickets: number
  /** How a daily says its step, which its figure alone doesn't. */
  label?: string
}

/** What a run below the first step pays, and the steps, lowest first. A run pays the highest it reaches. */
export type Ladder = { base: number; baseLabel?: string; steps: LadderStep[] }

/** The share of runs that reach each step, and what each pays. */
const SHARES = [0.5, 0.25, 0.1, 0.03] as const
const STEP_TICKETS = [3, 5, 7, 10] as const
const BASE_TICKETS = 1
/** With fewer runs than this, a game's own say too little: its ladder comes from the sample bands. */
const MIN_RUNS = 100
/** Where in a sample band (casual to elite) each step sits, for a game without runs enough. */
const BAND_AT = [0.25, 0.45, 0.65, 0.82] as const

/** A points figure that reads well: two figures from 100 up (147 → 150, 2,386 → 2,400), whole below. */
function nicePoints(v: number): number {
  if (v < 100) return Math.max(1, Math.round(v))
  const unit = 10 ** (Math.floor(Math.log10(v)) - 1)
  return Math.round(v / unit) * unit
}

/** A time (the base less the milliseconds) to the half second. */
function niceTime(score: number): number {
  return TIME_SCORE_BASE - Math.round((TIME_SCORE_BASE - score) / 500) * 500
}

/** A game's ladder from its runs, best first; or, with too few, from its sample band. */
function drawn(game: GameSlug, scores: readonly number[]): Ladder {
  const band = GAME_BANDS[game]
  const raw =
    scores.length >= MIN_RUNS
      ? // The best `share` of the runs reach the score that many places down.
        SHARES.map((share) => scores[Math.max(0, Math.ceil(share * scores.length) - 1)]!)
      : BAND_AT.map((t) => band.min + (band.max - band.min) * t)
  const nice = TIME_SCORED_GAMES.has(game) ? niceTime : nicePoints
  const steps: LadderStep[] = []
  raw.forEach((v, i) => {
    const at = nice(v)
    // Rounding can bring two steps together: the higher pays.
    while (steps.length && steps[steps.length - 1]!.at >= at) steps.pop()
    steps.push({ at, tickets: STEP_TICKETS[i]! })
  })
  return { base: BASE_TICKETS, steps }
}

const drawnToday = new Map<GameSlug, { day: number; ladder: Ladder }>()

async function drawnLadder(game: GameSlug, now: number): Promise<Ladder> {
  const day = boardDateKey(now)
  const held = drawnToday.get(game)
  if (held && held.day === day) return held.ladder
  const ladder = drawn(game, await runScores(game))
  drawnToday.set(game, { day, ladder })
  return ladder
}

const tries = (n: number) => TRIES_SCORE_BASE - n

/** Ace Chase: an ace 15, 2–3 tries 10, 4–6 tries 7, 7–10 tries 5, more 3. */
export const ACECHASE_LADDER: Ladder = {
  base: 3,
  baseLabel: 'a bullseye',
  steps: [
    { at: tries(10), tickets: 5, label: '10 tries or fewer' },
    { at: tries(6), tickets: 7, label: '6 tries or fewer' },
    { at: tries(3), tickets: 10, label: '3 tries or fewer' },
    { at: tries(1), tickets: 15, label: 'an ace' },
  ],
}

/**
 * Half Full, by the day's tier (the site's score.ts tierFor; the board is hundredths of a point): a pour 3,
 * Sloshy 5, Good Pour 7, Steady Hand 10, Spot On 15.
 */
export const HALFFULL_LADDER: Ladder = {
  base: 3,
  baseLabel: 'a pour today',
  steps: [
    { at: 7_600, tickets: 5, label: 'Sloshy' },
    { at: 8_600, tickets: 7, label: 'Good Pour' },
    { at: 9_200, tickets: 10, label: 'Steady Hand' },
    { at: 9_600, tickets: 15, label: 'Spot On' },
  ],
}

/**
 * Where a blue car can lap: the plan's made tracks pace 40–70 s and its landmarks (real circuits) up to
 * 100 s (the site's hotlap courses.ts and landmarks.ts). Only the site's own word is held to it.
 */
const PACE_MIN_MS = 40_000
const PACE_MAX_MS = 100_000
/** A blue car to show Hot Lap's ladder by, where no day's is given. */
const TYPICAL_PACE_MS = 53_000

/**
 * Hot Lap, on a day whose blue car laps in `paceMs`: slower than it 3, within 2% of it 5, beating it 8, by
 * 3% 11, by 6% 15. Without a blue car, a lap pays the 3 alone.
 */
export function hotlapLadder(paceMs: number | null | undefined): Ladder {
  const base = { base: 3, baseLabel: 'a lap today' }
  if (!paceMs) return { ...base, steps: [] }
  const pace = Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, Math.round(paceMs)))
  const lap = (ms: number) => TIME_SCORE_BASE - Math.round(ms)
  return {
    ...base,
    steps: [
      { at: lap(pace * 1.02), tickets: 5, label: 'within 2% of the blue car' },
      { at: lap(pace) + 1, tickets: 8, label: 'beating the blue car' },
      { at: lap(pace * 0.97), tickets: 11, label: 'beating it by 3%' },
      { at: lap(pace * 0.94), tickets: 15, label: 'beating it by 6%' },
    ],
  }
}

/**
 * The day's blue car from the plan: day 1 is the first day, and past the last planned day the days come
 * round again, as the site's dailyTrack has them. Null with no plan.
 */
export function plannedPace(now = Date.now()): number | null {
  if (!HOTLAP_PACE_MS.length) return null
  const key = boardDateKey(now)
  const [y0, m0, d0] = HOTLAP_FIRST_DAY.split('-').map(Number)
  const days = Math.round(
    (Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100) - Date.UTC(y0!, m0! - 1, d0!)) / 86_400_000,
  )
  return HOTLAP_PACE_MS[Math.max(0, days) % HOTLAP_PACE_MS.length] ?? null
}

/** A game's ladder today. Hot Lap's goes by the plan's blue car for the day, or else the one the site says. */
export async function ladderFor(game: GameSlug, now = Date.now(), paceMs?: number | null): Promise<Ladder> {
  if (game === 'acechase') return ACECHASE_LADDER
  if (game === 'halffull') return HALFFULL_LADDER
  if (game === 'hotlap') return hotlapLadder(plannedPace(now) ?? paceMs)
  return drawnLadder(game, now)
}

/** Every game's ladder, for the site to show: Hot Lap's by today's blue car, though the site shows its steps in words. */
export async function allLadders(now = Date.now()): Promise<Record<string, Ladder>> {
  const out: Record<string, Ladder> = {}
  for (const game of ALLOWED_GAMES) out[game] = await ladderFor(game, now, TYPICAL_PACE_MS)
  return out
}

/** The step a score reaches, if any, and the next one up. */
export function stepFor(ladder: Ladder, score: number): { tickets: number; reached: LadderStep | null; next: LadderStep | null } {
  let reached: LadderStep | null = null
  let next: LadderStep | null = null
  for (const step of ladder.steps) {
    if (score >= step.at) reached = step
    else {
      next = step
      break
    }
  }
  return { tickets: reached?.tickets ?? ladder.base, reached, next }
}
