import type { GameSlug } from './store.js'

/**
 * Time-scored boards keep "higher is better" by storing the base minus the
 * run in milliseconds (the site's findbug, spotter, hotlap, marblerun, lander, swoop and wobblerun score.ts).
 * A run therefore lives strictly below the base: a score at or above it is
 * a clear in zero or negative time, which the site prints as "0.0s".
 */
export const TIME_SCORE_BASE = 1_000_000

export const TIME_SCORED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['findbug', 'spotter', 'hotlap', 'marblerun', 'lander', 'swoop', 'wobblerun', 'sling'])

/**
 * Tries-scored boards keep "higher is better" the same way, as the base less
 * the tries: Ace Chase's is the tries a day's first bullseye took at Today's
 * Hole, so 999,999 is an ace. The site's acechase/score.ts reads it back.
 */
export const TRIES_SCORE_BASE = 1_000_000

export const TRIES_SCORED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['acechase'])

/** The largest score a real run of this game can post. */
export function scoreCeiling(game: GameSlug): number {
  // Half Full's day, in hundredths of a point: 10,000 is five pours dead on half.
  if (game === 'halffull') return 10_000
  // Centroid's day (since 2026-10-06 a daily), in hundredths of a point: 10,000 is six pins dead on.
  if (game === 'centroid') return 10_000
  if (TIME_SCORED_GAMES.has(game)) return TIME_SCORE_BASE - 1
  if (TRIES_SCORED_GAMES.has(game)) return TRIES_SCORE_BASE - 1
  return TIME_SCORE_BASE
}

/**
 * Where sample data stops for the time-scored games: the top of each seed
 * band, so a jittered elite run cannot read as a superhuman time. Find the
 * Bug is five scenes, so 25 seconds is already a very good sweep; Spotter is
 * one picture, and half a second is the fastest a hand can be; Hot Lap's pace
 * car goes round in 53 seconds, and 50 is a lap on the limit.
 */
const SEED_TIME_CAPS: Partial<Record<GameSlug, number>> = {
  findbug: TIME_SCORE_BASE - 25_000,
  spotter: TIME_SCORE_BASE - 500,
  hotlap: TIME_SCORE_BASE - 50_000,
}

export function seedScoreCap(game: GameSlug): number {
  return SEED_TIME_CAPS[game] ?? Number.POSITIVE_INFINITY
}

/**
 * How fast a score can legitimately grow.
 *
 * A points game can only accumulate so much per second of play, so a score is
 * checked against the wall time the server itself measured between issuing the
 * run id and the score arriving. A time-scored game is stricter: its score IS
 * a duration, so the server can check the claimed time against its own clock.
 *
 * `perSecond` is set at roughly five times the rate an elite run reaches in
 * GAME_BANDS (seedBoards.ts), and `floor` lets a short run bank a modest score
 * without tripping. They are deliberately loose: rejecting a real player's best
 * run is far worse than letting a patient cheat through, and a cap cannot stop
 * someone willing to idle a real run anyway. Its job is to make an instant
 * jackpot impossible and to bound how much damage one forged run can do.
 *
 * These are first-pass numbers. `leaderboard_scores.duration_ms` now records
 * what real runs actually take, so tighten them against that data rather than
 * against a guess.
 */
type ScoreRule =
  /** Points accrue over time: score <= floor + perSecond * seconds elapsed. */
  | { kind: 'rate'; floor: number; perSecond: number }
  /**
   * Points compound, so the allowance has to bend with them.
   *
   * A game where what you earn depends on what you have already earned does
   * not score at a rate — Frenzy pays by the level you grew to, so a minute in
   * is worth many times the first. A straight line fitted to the end of such a
   * run is wildly generous at the start of one, which is exactly where a
   * forged score arrives.
   */
  | { kind: 'curve'; floor: number; perSecond: number; perSecondSquared: number }
  /** Score encodes TIME_SCORE_BASE - milliseconds; the clock must agree. */
  | { kind: 'time' }
  /**
   * Score encodes TRIES_SCORE_BASE - tries. No clock can check tries, which
   * may be spread over a whole day; the board takes them only from Today's
   * Hole (dailyHole.ts), one result an account a day.
   */
  | { kind: 'tries' }
  /**
   * The API works the score out itself from what was played (Half Full's five levels, halffull/save.ts),
   * so the figure the site sends is never taken; how long the pours took is held to its own floor.
   */
  | { kind: 'judged' }

const SCORE_RULES: Record<GameSlug, ScoreRule> = {
  /*
   * Rocks pay 20/50/100 doubled by a five-hit combo, the gun fires on its own,
   * and a cleared wave pays for time under par, so the points come at a steady
   * rate. Measured with the game's own engine (2026-10-20): a bot that leads
   * every shot exactly scores about 620 a second all run (39,000 in a minute,
   * 372,000 in ten), one aiming 180 ms late about 370, a steady player 165. The
   * old 2,000 + 200/s refused the second within thirty seconds and flagged the
   * third. These keep the first under the near-cap flag (0.83 at worst).
   */
  asteroids: { kind: 'rate', floor: 4_000, perSecond: 800 },
  patriot: { kind: 'rate', floor: 3_000, perSecond: 300 },
  snake: { kind: 'rate', floor: 200, perSecond: 25 },
  crosswalk: { kind: 'rate', floor: 50, perSecond: 12 },
  stacker: { kind: 'rate', floor: 30, perSecond: 4 },
  // A daily since 2026-10-06: the API works its day out from the six taps (centroid/save.ts).
  centroid: { kind: 'judged' },
  /*
   * A round is 45 seconds. Measured with the game's own engine since the
   * bubbles (73ba1a17): a bot that pops every bubble dead centre the instant
   * it can scores 5,600–6,060; one with a fifth-second reaction and 80% centres
   * 5,000–5,600; a steady player around 4,000. The old 200 + 60/s (2,900 at
   * 45 s) refused all of them. These allow 7,700 at 45 s, and a perfect run
   * stays under the near-cap flag.
   */
  pop: { kind: 'rate', floor: 500, perSecond: 160 },
  simon: { kind: 'rate', floor: 5, perSecond: 1.5 },
  /*
   * Measured with the game's own engine (2026-10-20): a bot with instant
   * reactions that baits all four chasers onto a glowberry, eats them, and
   * rides the hundred-in-a-row fright banks 15,000 in its first twenty seconds,
   * and never dies: ~135,000 in ten minutes. One with a 180 ms reaction reached
   * 16,000 by 42 s. The old 2,000 + 250/s refused both, and flagged a steady
   * player. These keep the instant bot under the near-cap flag everywhere
   * (worst 0.82, at 49 s).
   */
  pellets: { kind: 'rate', floor: 15_000, perSecond: 300 },
  /*
   * Measured with the game's own engine (2026-10-20): every row pays, the
   * streak runs to x8 through the crumbed gaps, and fruit grows with depth, so
   * a bot with instant reactions scores ~440/s on a phone's ten columns and
   * ~550/s on a desktop's twenty-one (330,000 in ten minutes, without dying);
   * one with a 180 ms reaction 115,000 in four. The old 2,000 + 250/s refused
   * even a steady player. These keep the instant bot under the near-cap flag
   * (worst 0.83, desktop, three minutes in).
   */
  crumbtrail: { kind: 'rate', floor: 30_000, perSecond: 650 },
  /*
   * A right call is a point, a quick one two, and a third of a second passes
   * between calls. Measured with the game's own engine (2026-10-20): a bot that
   * answers every call the frame it comes up scores 6 a second for as long as
   * it likes (3,600 in ten minutes); a ~180 ms keyboard hand makes about 3.8,
   * which the old 20 + 4/s flagged near the cap within a minute (and the bot
   * broke); a good keyboard player ~2.9, a phone player under 1.5. These leave
   * the bot under 0.8 of the cap at every point.
   */
  bop: { kind: 'rate', floor: 20, perSecond: 7.5 },
  /*
   * Five holes, par 2: an ace pays 500, so a round tops out at 2,500. Measured
   * with the game's own engine (2026-10-20): every hole can be aced, and five
   * aces with no time spent aiming end at about 26 seconds, past the old
   * 500 + 80/s's near-cap flag; a top round is 1,000–1,600 in 35–60 s. The
   * floor of 900 keeps even the five-ace round under the flag on a quick save.
   */
  putt: { kind: 'rate', floor: 900, perSecond: 80 },
  barrage: { kind: 'rate', floor: 500, perSecond: 400 },
  /*
   * Measured, not guessed: a bot that plays Frenzy badly reaches 24,000 in
   * ninety-seven seconds, and almost nothing in the first ten. These leave
   * roughly four times the bot's best at every point on that curve.
   */
  frenzy: { kind: 'curve', floor: 300, perSecond: 100, perSecondSquared: 10 },
  /*
   * A point a note, a catch and a lantern rung, three for a Follow. Measured
   * with the game's own engine (2026-10-20): a bot that taps every tune back
   * the frame it ends and never misses a Catch or a Follow scores 390 in five
   * minutes, 860 in ten and 6,975 in an hour, since each tune takes its full
   * length to watch; a ~180 ms hand makes 720 in ten. These leave that bot
   * under half the cap at ten minutes and under two thirds at an hour.
   */
  fireflies: { kind: 'rate', floor: 20, perSecond: 3 },
  /*
   * Rows pay ten to eighty times the level, and the level climbs a step every
   * ten rows, so the points compound as Frenzy's do. Measured with the game's
   * own engine (2026-10-20) and a stacker that clears 97% of its rows four at
   * a time, back to back: at 4 pieces a second (faster than any hand on these
   * keys) it scores 9,600 in a minute, 236,000 in five and 900,000 in ten,
   * which the old 1,000 + 50 s + 2 s² refused after two minutes; keyed in at
   * a top player's speed, where the high levels' gravity blocks slides, it
   * tops out near half the old cap. These keep the 4-a-second bot under 0.75
   * of the cap at every point.
   */
  pileup: { kind: 'curve', floor: 1_000, perSecond: 50, perSecondSquared: 3.5 },
  acechase: { kind: 'tries' },
  findbug: { kind: 'time' },
  spotter: { kind: 'time' },
  hotlap: { kind: 'time' },
  halffull: { kind: 'judged' },
  marblerun: { kind: 'time' },
  lander: { kind: 'time' },
  swoop: { kind: 'time' },
  wobblerun: { kind: 'time' },
  sling: { kind: 'time' },
}

/**
 * A run's own clock starts after the server issues the id — a countdown, a
 * first render, a player who reads the rules. Server-measured time is therefore
 * always the longer of the two, and only a margin for clock skew is needed.
 */
const TIME_TOLERANCE = 0.9

/**
 * The most a points game could have scored in this much time.
 *
 * Null for the time-scored games, where the score is not accumulated and the
 * question does not apply. Exposed so the flagging can ask how close to the
 * edge a score sat, which is a different question from whether it was allowed.
 */
export function rateAllowance(game: GameSlug, elapsedMs: number): number | null {
  const rule = SCORE_RULES[game]
  if (!rule) return null
  const seconds = elapsedMs / 1000
  if (rule.kind === 'rate') return rule.floor + rule.perSecond * seconds
  if (rule.kind === 'curve') {
    return rule.floor + rule.perSecond * seconds + rule.perSecondSquared * seconds * seconds
  }
  return null
}

export type PlausibilityVerdict =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Is this score reachable in the time that actually passed?
 *
 * Slow play always passes: elapsed only ever makes the allowance larger. The
 * only thing this rejects is a score arriving faster than the game can produce
 * one.
 */
export function checkScoreRate(
  game: GameSlug,
  score: number,
  elapsedMs: number,
): PlausibilityVerdict {
  const rule = SCORE_RULES[game]
  if (!rule || rule.kind === 'tries' || rule.kind === 'judged') return { ok: true }

  if (rule.kind === 'time') {
    const impliedMs = TIME_SCORE_BASE - score
    if (elapsedMs < impliedMs * TIME_TOLERANCE) {
      return {
        ok: false,
        reason: `a ${(impliedMs / 1000).toFixed(1)}s run cannot arrive ${(elapsedMs / 1000).toFixed(1)}s after it started`,
      }
    }
    return { ok: true }
  }

  const allowed = rateAllowance(game, elapsedMs)
  if (allowed != null && score > allowed) {
    return {
      ok: false,
      reason: `${score} points in ${(elapsedMs / 1000).toFixed(1)}s is past this game's fastest possible scoring`,
    }
  }
  return { ok: true }
}
