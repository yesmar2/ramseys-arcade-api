import type { GameSlug } from './store.js'

/**
 * Time-scored boards keep "higher is better" by storing the base minus the
 * run in milliseconds (the site's findbug/score.ts and spotter/score.ts).
 * A run therefore lives strictly below the base: a score at or above it is
 * a clear in zero or negative time, which the site prints as "0.0s".
 */
export const TIME_SCORE_BASE = 1_000_000

export const TIME_SCORED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['findbug', 'spotter'])

/** The largest score a real run of this game can post. */
export function scoreCeiling(game: GameSlug): number {
  return TIME_SCORED_GAMES.has(game) ? TIME_SCORE_BASE - 1 : TIME_SCORE_BASE
}

/**
 * Where sample data stops for the time-scored games: the top of each seed
 * band, so a jittered elite run cannot read as a superhuman time. Find the
 * Bug is five scenes, so 25 seconds is already a very good sweep; Spotter is
 * one picture, and half a second is the fastest a hand can be.
 */
const SEED_TIME_CAPS: Partial<Record<GameSlug, number>> = {
  findbug: TIME_SCORE_BASE - 25_000,
  spotter: TIME_SCORE_BASE - 500,
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
  /** Score encodes TIME_SCORE_BASE - milliseconds; the clock must agree. */
  | { kind: 'time' }

const SCORE_RULES: Record<GameSlug, ScoreRule> = {
  asteroids: { kind: 'rate', floor: 2_000, perSecond: 200 },
  patriot: { kind: 'rate', floor: 3_000, perSecond: 300 },
  snake: { kind: 'rate', floor: 200, perSecond: 25 },
  crosswalk: { kind: 'rate', floor: 50, perSecond: 12 },
  stacker: { kind: 'rate', floor: 30, perSecond: 4 },
  centroid: { kind: 'rate', floor: 1_000, perSecond: 150 },
  pop: { kind: 'rate', floor: 200, perSecond: 60 },
  simon: { kind: 'rate', floor: 5, perSecond: 1.5 },
  pellets: { kind: 'rate', floor: 2_000, perSecond: 250 },
  crumbtrail: { kind: 'rate', floor: 2_000, perSecond: 250 },
  bop: { kind: 'rate', floor: 20, perSecond: 4 },
  putt: { kind: 'rate', floor: 500, perSecond: 80 },
  findbug: { kind: 'time' },
  spotter: { kind: 'time' },
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
  if (!rule || rule.kind !== 'rate') return null
  return rule.floor + rule.perSecond * (elapsedMs / 1000)
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
  if (!rule) return { ok: true }

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

  const allowed = rule.floor + rule.perSecond * (elapsedMs / 1000)
  if (score > allowed) {
    return {
      ok: false,
      reason: `${score} points in ${(elapsedMs / 1000).toFixed(1)}s is past this game's fastest possible scoring`,
    }
  }
  return { ok: true }
}
