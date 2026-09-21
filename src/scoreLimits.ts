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
