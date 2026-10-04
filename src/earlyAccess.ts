import type { GameSlug } from './store.js'
import { boardDateKey } from './store.js'

/*
 * Early access (Ramsey's picks, 2026-10-04: Plus as the Dailies + Seasons membership, and a week early). A new
 * game's launch day, YYYY-MM-DD: the site lets Plus members play it the week before, as practice. Its boards
 * take no runs until launch day and open to everyone together, so nobody buys a head start on them. The
 * site's data/games.ts Game.launchDay says the same. Take a game off once its day has come and gone.
 */
export const LAUNCH_DAYS: Partial<Record<GameSlug, string>> = {}

/** Whether a game hasn't launched yet: its boards take no runs until launch day. */
export function beforeLaunch(game: GameSlug, now = Date.now()): boolean {
  const day = LAUNCH_DAYS[game]
  return day != null && boardDateKey(now) < Number(day.replaceAll('-', ''))
}
