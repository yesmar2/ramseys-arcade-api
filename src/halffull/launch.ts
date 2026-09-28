/**
 * Half Full #1: the first day its board, its day points and its record book count from. The same day as
 * the site's src/games/halffull/daily.ts FIRST_DAY (`npm run check:halffull` holds them together).
 */
export const HALFFULL_FIRST_DAY = '2026-09-28'

/** The same day as a board day key, YYYYMMDD. */
export const HALFFULL_FIRST_KEY = Number(HALFFULL_FIRST_DAY.replace(/-/g, ''))

/**
 * The day Today's Pour joins the Today set (today.ts), YYYY-MM-DD: null until Half Full's launch. The launch
 * sets it here and in the site's src/games/halffull/daily.ts TODAY_FROM (`npm run check:halffull`).
 */
export const HALFFULL_TODAY_FROM: string | null = null
