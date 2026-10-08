import { HOTLAP_FIRST_DAY, HOTLAP_PACE_MS } from './hotlapPace.js'
import { LANDER_FIRST_DAY, LANDER_PACE_MS } from './landerPace.js'
import { MARBLERUN_FIRST_DAY, MARBLERUN_PACE_MS } from './marblerunPace.js'
import { SWOOP_FIRST_DAY, SWOOP_PACE_MS } from './swoopPace.js'
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
 * hole is held to the same difficulty. Find the Bug goes by its time, on steps
 * that stay put: it's just for fun (store.ts UNRANKED_GAMES), so what others do
 * doesn't move them, as it moved its drawn ladder before. Half Full by the day's tier. Hot Lap goes by the day's blue car
 * (the pace car), since its track changes every day: the plan's own, kept in
 * hotlapPace.ts, so the site can't say a slower one; Marble Run by the day's
 * blue ball (its pace ball), from marblerunPace.ts, Lander by the day's
 * blue ship, from landerPace.ts, and Swoop by the day's blue bird, from
 * swoopPace.ts. A daily pays its best
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
 * Find the Bug, by the time its first run of the day took to find all five (the board's figure is the base
 * less the milliseconds): any sweep 3, a minute or less 5, 50 s 7, 42 s 10, 36 s 15. Drawn from its runs on
 * 2026-09-30, when the top half, quarter, tenth and 3% took 59.5 s, 50 s, 43 s and 39.5 s.
 */
export const FINDBUG_LADDER: Ladder = {
  base: 3,
  baseLabel: 'all five found',
  steps: [
    { at: TIME_SCORE_BASE - 60_000, tickets: 5, label: '60s or faster' },
    { at: TIME_SCORE_BASE - 50_000, tickets: 7, label: '50s or faster' },
    { at: TIME_SCORE_BASE - 42_000, tickets: 10, label: '42s or faster' },
    { at: TIME_SCORE_BASE - 36_000, tickets: 15, label: '36s or faster' },
  ],
}

/**
 * Centroid's daily, by the day's tier (the site's dead-center/score.ts tierFor; the board is hundredths of a
 * point): a day 3, Tipsy 5, Wobbly 7, Steady 10, Dead Center 15.
 */
export const CENTROID_LADDER: Ladder = {
  base: 3,
  baseLabel: 'today’s plates',
  steps: [
    { at: 7_000, tickets: 5, label: 'Tipsy' },
    { at: 8_200, tickets: 7, label: 'Wobbly' },
    { at: 9_000, tickets: 10, label: 'Steady' },
    { at: 9_500, tickets: 15, label: 'Dead Center' },
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
 * The racing dailies' steps are their medals (the site's lib/raceMedals.ts): beating the day's blue pays 5
 * (bronze), and each step of the game's faster than it pays the next, 8, 11 and 15 (silver, gold, platinum).
 * They were 3% and 6% for the top two until Ramsey found platinum came "almost every time" (2026-10-06): his
 * best runs of the day land 15 to 30% under the blue, which drives carefully, and each blue leaves its own
 * slack. Steps of 6, 7 and 8% put platinum about where his best runs land; he found that "still needs to be a
 * little harder", so it's a point more a step in Lander and Marble Run: platinum is 24% and 27% there. Hot Lap
 * went to 7% too, then back to 6% (platinum 18%) once he found its platinum "just a little too hard". Swoop
 * came at 7% (platinum 21%); on its first day his run was 36.6% under the blue bird, so the bird went 10%
 * quicker (the site's swoop sim.ts BLUE_PACE; swoopPace.ts is its quicker times) and its steps went to 10%
 * (platinum 30%), as he picked ("blue needs to be a little bit harder ... the medals for swoop need to be
 * harder too"). On the longer hills his best runs then landed 35 to 38% under the bird, platinum every time,
 * so Swoop's steps went to 12% (platinum 36%) when he found its medals still needed to be "a little more
 * difficult" (2026-10-07). Marble Run's went to 12% too (platinum 36%) when he asked for its medals to be
 * harder (2026-10-08), right after its marble got easier to turn and slow down (the site's marblerun sim.ts
 * PLAYER_TILT_MAX, PLAYER_BRAKE): his runs had landed 27 to 32% under the blue ball, and the easier marble
 * takes about 4% more off a quick player's time. A run slower than the blue pays the base 3.
 */
export const RACE_MEDAL_STEP = { hotlap: 0.06, marblerun: 0.12, lander: 0.08, swoop: 0.12 } as const

/**
 * A racing daily's steps on a day whose blue goes in `pace` ms, `score` turning a time into a board score.
 * Each rung names what it beats: a run's tickets say one rung on its own, where "it" would be nothing
 * (Ramsey, 2026-10-05: "People won't know what 'it' is"). The same sums as the site's medalTimes.
 */
function raceSteps(pace: number, step: number, blue: string, score: (ms: number) => number): LadderStep[] {
  const pct = (k: number) => Math.round(k * step * 100)
  return [
    { at: score(pace) + 1, tickets: 5, label: `beating the ${blue}` },
    { at: score(pace * (1 - step)), tickets: 8, label: `beating the ${blue} by ${pct(1)}%` },
    { at: score(pace * (1 - 2 * step)), tickets: 11, label: `beating the ${blue} by ${pct(2)}%` },
    { at: score(pace * (1 - 3 * step)), tickets: 15, label: `beating the ${blue} by ${pct(3)}%` },
  ]
}

/**
 * Hot Lap, on a day whose blue car laps in `paceMs`: slower than it 3, beating it 5, by 6% 8, by 12% 11, by
 * 18% 15. Without a blue car, a lap pays the 3 alone.
 */
export function hotlapLadder(paceMs: number | null | undefined): Ladder {
  const base = { base: 3, baseLabel: 'a lap today' }
  if (!paceMs) return { ...base, steps: [] }
  const pace = Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, Math.round(paceMs)))
  const lap = (ms: number) => TIME_SCORE_BASE - Math.round(ms)
  return { ...base, steps: raceSteps(pace, RACE_MEDAL_STEP.hotlap, 'blue car', lap) }
}

/**
 * A day's pace from a plan: day 1 is the first day, and past the last planned day the days come round
 * again, as the site's dailyTrack and dailyCourse have them. Null with no plan.
 */
function paceOnDay(firstDay: string, paces: readonly number[], now: number): number | null {
  if (!paces.length) return null
  const key = boardDateKey(now)
  const [y0, m0, d0] = firstDay.split('-').map(Number)
  const days = Math.round(
    (Date.UTC(Math.floor(key / 10_000), (Math.floor(key / 100) % 100) - 1, key % 100) - Date.UTC(y0!, m0! - 1, d0!)) / 86_400_000,
  )
  return paces[Math.max(0, days) % paces.length] ?? null
}

/** The day's blue car from Hot Lap's plan. */
export function plannedPace(now = Date.now()): number | null {
  return paceOnDay(HOTLAP_FIRST_DAY, HOTLAP_PACE_MS, now)
}

/** The day's blue ball from Marble Run's plan. */
export function marblerunPlannedPace(now = Date.now()): number | null {
  return paceOnDay(MARBLERUN_FIRST_DAY, MARBLERUN_PACE_MS, now)
}

/** Where a blue ball can roll: the plan's courses pace 44–77 s. */
const BALL_MIN_MS = 30_000
const BALL_MAX_MS = 90_000

/**
 * Marble Run, on a day whose blue ball rolls down in `paceMs`: slower than it 3, beating it 5, by 12% 8, by
 * 24% 11, by 36% 15, as Hot Lap pays against its blue car. Without a blue ball, a run pays the 3 alone.
 */
export function marblerunLadder(paceMs: number | null | undefined): Ladder {
  const base = { base: 3, baseLabel: 'a run today' }
  if (!paceMs) return { ...base, steps: [] }
  const pace = Math.min(BALL_MAX_MS, Math.max(BALL_MIN_MS, Math.round(paceMs)))
  const run = (ms: number) => TIME_SCORE_BASE - Math.round(ms)
  return { ...base, steps: raceSteps(pace, RACE_MEDAL_STEP.marblerun, 'blue ball', run) }
}

/** The day's blue ship from Lander's plan. */
export function landerPlannedPace(now = Date.now()): number | null {
  return paceOnDay(LANDER_FIRST_DAY, LANDER_PACE_MS, now)
}

/** Where a blue ship can fly: the plan's caves pace 42–80 s. */
const SHIP_MIN_MS = 35_000
const SHIP_MAX_MS = 100_000

/**
 * Lander, on a day whose blue ship lands in `paceMs`: slower than it 3, beating it 5, by 8% 8, by 16% 11, by
 * 24% 15, as Hot Lap pays against its blue car and Marble Run against its blue ball. Without a blue ship, a
 * run pays the 3 alone.
 */
export function landerLadder(paceMs: number | null | undefined): Ladder {
  const base = { base: 3, baseLabel: 'a run today' }
  if (!paceMs) return { ...base, steps: [] }
  const pace = Math.min(SHIP_MAX_MS, Math.max(SHIP_MIN_MS, Math.round(paceMs)))
  const run = (ms: number) => TIME_SCORE_BASE - Math.round(ms)
  return { ...base, steps: raceSteps(pace, RACE_MEDAL_STEP.lander, 'blue ship', run) }
}

/** The day's blue bird from Swoop's plan. */
export function swoopPlannedPace(now = Date.now()): number | null {
  return paceOnDay(SWOOP_FIRST_DAY, SWOOP_PACE_MS, now)
}

/** Where a blue bird can fly: the plan's hills, 75% longer since 2026-10-06, pace 67–107 s. */
const BIRD_MIN_MS = 50_000
const BIRD_MAX_MS = 140_000

/**
 * Swoop, on a day whose blue bird crosses the line in `paceMs`: slower than it 3, beating it 5, by 12% 8, by
 * 24% 11, by 36% 15, as the other racing dailies pay against their blues. Without a blue bird, a run pays the
 * 3 alone.
 */
export function swoopLadder(paceMs: number | null | undefined): Ladder {
  const base = { base: 3, baseLabel: 'a run today' }
  if (!paceMs) return { ...base, steps: [] }
  const pace = Math.min(BIRD_MAX_MS, Math.max(BIRD_MIN_MS, Math.round(paceMs)))
  const run = (ms: number) => TIME_SCORE_BASE - Math.round(ms)
  return { ...base, steps: raceSteps(pace, RACE_MEDAL_STEP.swoop, 'blue bird', run) }
}

/** A game's ladder today. Hot Lap's goes by the plan's blue car for the day, or else the one the site says. */
export async function ladderFor(game: GameSlug, now = Date.now(), paceMs?: number | null): Promise<Ladder> {
  if (game === 'acechase') return ACECHASE_LADDER
  if (game === 'findbug') return FINDBUG_LADDER
  if (game === 'halffull') return HALFFULL_LADDER
  if (game === 'centroid') return CENTROID_LADDER
  if (game === 'hotlap') return hotlapLadder(plannedPace(now) ?? paceMs)
  if (game === 'marblerun') return marblerunLadder(marblerunPlannedPace(now) ?? paceMs)
  if (game === 'lander') return landerLadder(landerPlannedPace(now) ?? paceMs)
  if (game === 'swoop') return swoopLadder(swoopPlannedPace(now) ?? paceMs)
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
