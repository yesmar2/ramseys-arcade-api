import type { GameSlug } from './store.js'
import { boardDateKey } from './store.js'

/*
 * Early access (Ramsey's pick, 2026-10-04: Plus as the Dailies + Seasons membership). A new game can open to
 * Plus members before its day: they play it first, as practice. Its boards open to everyone together on its
 * day, so nobody buys a head start on them. A game here is YYYY-MM-DD, the day it opens to all; the site's
 * data/games.ts Game.plusFirst says the same. Take a game off once its day has come and gone.
 */
export const PLUS_FIRST: Partial<Record<GameSlug, string>> = {}

/** Whether a game is still in early access: its boards take no runs until its day. */
export function inEarlyAccess(game: GameSlug, now = Date.now()): boolean {
  const day = PLUS_FIRST[game]
  return day != null && boardDateKey(now) < Number(day.replaceAll('-', ''))
}
