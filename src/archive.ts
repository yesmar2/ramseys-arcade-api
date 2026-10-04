import { boardDateKey } from './store.js'

/*
 * The dailies' archive (Ramsey's pick, 2026-10-04: Plus as the Dailies + Seasons membership). A daily's past
 * days from the last week are everyone's, as they always were: played again, and a run onto a course's own
 * board. Older days are the archive: the site opens them to Plus members, as practice. A run on one is never
 * put on a board, whoever sends it, so Plus never buys a place on one.
 */

/** How many past days are open to everyone: the week before today. */
export const OPEN_DAYS = 7

/** Whether a day, YYYY-MM-DD, is older than the week of past days open to everyone, on the boards' clock. */
export function inArchive(day: string, now = Date.now()): boolean {
  const today = boardDateKey(now)
  // UTC date math on the parts, as the board keys do.
  const since = new Date(Date.UTC(Math.floor(today / 10_000), (Math.floor(today / 100) % 100) - 1, (today % 100) - OPEN_DAYS))
  const key = since.getUTCFullYear() * 10_000 + (since.getUTCMonth() + 1) * 100 + since.getUTCDate()
  return Number(day.replaceAll('-', '')) < key
}

/** The refusal for a run on an archived course: practice, kept nowhere. */
export const ARCHIVED = { error: 'A course’s board closes a week after its day: that run was practice', code: 'ARCHIVED' } as const
