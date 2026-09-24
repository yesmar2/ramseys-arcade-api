import { TIME_SCORE_BASE, TIME_SCORED_GAMES } from './scoreLimits.js'
import type { GameSlug } from './store.js'

/*
 * Numbers and names the way the site says them, for text the API writes
 * itself: notifications, challenge lines, push alerts.
 */

export const GAME_LABELS: Record<GameSlug, string> = {
  barrage: 'Barrage',
  frenzy: 'Frenzy',
  stacker: 'Stacker',
  patriot: 'Patriot',
  snake: 'Snake',
  pop: 'Pop',
  centroid: 'Centroid',
  asteroids: 'Asteroids',
  simon: 'Simon',
  crosswalk: 'Crosswalk',
  spotter: 'Spotter',
  pellets: 'Pellets',
  findbug: 'Find the Bug',
  crumbtrail: 'Crumbtrail',
  bop: 'Bop',
  putt: 'Putt',
  fireflies: 'Fireflies',
}

export function gameLabel(game: string): string {
  return GAME_LABELS[game as GameSlug] ?? game
}

/** Games whose score counts something with a name of its own. */
const UNITS: Partial<Record<GameSlug, [string, string]>> = {
  crosswalk: ['row', 'rows'],
  stacker: ['block', 'blocks'],
  simon: ['round', 'rounds'],
  fireflies: ['note', 'notes'],
}

export function isTime(game: GameSlug) {
  return TIME_SCORED_GAMES.has(game)
}

/** A time the way the site prints one: 47.5s, or 1:02.3 past a minute. */
export function clock(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`
}

/** A score as the board shows it: 447, 14,310, 47.5s. */
export function scoreFigure(game: GameSlug, score: number): string {
  return isTime(game) ? clock(TIME_SCORE_BASE - score) : score.toLocaleString('en-US')
}

/** A score with its unit where the game has one: 447 rows, 14,310, 47.5s. */
export function scoreWords(game: GameSlug, score: number): string {
  if (isTime(game)) return scoreFigure(game, score)
  const unit = UNITS[game]
  if (!unit) return scoreFigure(game, score)
  return `${scoreFigure(game, score)} ${score === 1 ? unit[0] : unit[1]}`
}

/** A gap between two scores in the game's own terms: 6 rows, 1 point, 0.4s. */
export function gapWords(game: GameSlug, gap: number): string {
  if (isTime(game)) return `${(gap / 1000).toFixed(1)}s`
  const [one, many] = UNITS[game] ?? ['point', 'points']
  return `${gap.toLocaleString('en-US')} ${gap === 1 ? one : many}`
}

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

export function pts(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'pt' : 'pts'}`
}

/** Time left on a clock, rounded the way a person says it: 2 hours, 45 minutes. */
export function timeLeft(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? '1 hour' : `${hours} hours`
}

/** How long something lasted, roughly: under an hour, 5 hours, 3 days, 2 weeks. */
export function spanWords(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 1) return 'under an hour'
  if (hours < 36) {
    const h = Math.round(hours)
    return h === 1 ? 'an hour' : `${h} hours`
  }
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} days`
  const weeks = Math.round(days / 7)
  return `${weeks} weeks`
}

/** A list the way it's said: Snake, Putt and Bop. */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
