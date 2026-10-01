import { addRecord, courseRecordId, seedRecordEntry } from './records.js'
import { TIME_SCORE_BASE } from './scoreLimits.js'
import { boardDateKey, type DeviceType, type GameSlug } from './store.js'
import { dayNumberOf, trackBoard, trackCount, trackOfDay } from './trackLaps.js'

/*
 * Course records (records.ts): each Hot Lap track's record, kept with its game's records though players'
 * books leave them out (each is just its track's #1): what goes by them is a record's tickets and the note to
 * its last holder. What goes in is what goes on the track's own board (trackLaps.ts), as it goes on: a lap on
 * its day, and one on it since. What was set before the books kept them is put in once, at start
 * (syncCourseRecords), with no one told their record was taken. Ace Chase's holes and Find the Bug's and Half
 * Full's days kept records too, until those games became just for fun (store.ts UNRANKED_GAMES).
 */

/** A lap or result into its track's, hole's or day's record book: never in the way of the save it came with. */
export async function noteCourseRecord(game: GameSlug, n: number, name: string, value: number, device: DeviceType): Promise<void> {
  const id = courseRecordId(game, n)
  if (!id) return
  await addRecord(game, id, name, value, device).catch((err: unknown) => {
    console.warn(`[course records] ${game} ${id} for ${name}:`, err)
  })
}

/**
 * A run saved to today's board of a daily with a record a day (routes.ts), into that day's book: Hot Lap's
 * lap into today's track's, timed (a million less its milliseconds, and a record is the fewest).
 */
export async function noteDayRun(game: GameSlug, name: string, score: number, device: DeviceType, at = Date.now()): Promise<void> {
  if (game !== 'hotlap') return
  const day = dayNumberOf(boardDateKey(at))
  if (day >= 1) await noteCourseRecord('hotlap', trackOfDay(day), name, TIME_SCORE_BASE - score, device)
}

/**
 * Every track's board into its record book, for what was set before the books kept them: each player's
 * best, at the time it was set. Only a best the book hasn't got goes in, so it's safe to run at every start.
 * How many went in.
 */
export async function syncCourseRecords(now = Date.now()): Promise<number> {
  let added = 0
  const days = Math.min(dayNumberOf(boardDateKey(now)), trackCount())
  for (let n = 1; n <= days; n++) {
    const id = courseRecordId('hotlap', n)
    if (!id) continue
    for (const e of await trackBoard('hotlap', n, now)) {
      if (await seedRecordEntry('hotlap', id, { name: e.name, score: TIME_SCORE_BASE - e.score, at: e.at, device: e.device })) added++
    }
  }
  return added
}
