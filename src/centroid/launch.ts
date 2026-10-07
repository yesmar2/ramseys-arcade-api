/**
 * Centroid's daily #1: the first day its board and day points count from (Ramsey, 2026-10-06: "centroid
 * should be a daily like the fill the cup game"). The same day as the site's src/games/dead-center/daily.ts
 * FIRST_DAY (`npm run check:centroid` holds them together).
 */
export const CENTROID_FIRST_DAY = '2026-10-06'

/** The same day as a board day key, YYYYMMDD. */
export const CENTROID_FIRST_KEY = Number(CENTROID_FIRST_DAY.replace(/-/g, ''))

/**
 * The day Today's Plates joined the Dailies, under the ticket with the puzzles (today.ts), YYYY-MM-DD. The same
 * day as the site's daily.ts TODAY_FROM (`npm run check:centroid`).
 */
export const CENTROID_TODAY_FROM: string | null = '2026-10-06'
