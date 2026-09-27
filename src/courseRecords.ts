import { holeBoard, holeCount, holeDay, holeNumber, holeToday } from './holes.js'
import { addRecord, courseRecordId, seedRecordEntry } from './records.js'
import { TIME_SCORE_BASE } from './scoreLimits.js'
import { boardDateKey, type DeviceType, type GameSlug } from './store.js'
import { dayNumberOf, trackBoard, trackCount, trackOfDay } from './trackLaps.js'

/*
 * Course records (records.ts): each Hot Lap track's and each Ace Chase hole's record, in its game's record
 * book. What goes in is what goes on the track's or hole's own board (trackLaps.ts, holes.ts), as it goes
 * on: a lap or result on its day, and one on it since. What was set before the books kept them is put in
 * once, at start (syncCourseRecords), with no one told their record was taken.
 */

/** A lap or result into its track's or hole's record book: never in the way of the save it came with. */
export async function noteCourseRecord(game: GameSlug, n: number, name: string, value: number, device: DeviceType): Promise<void> {
  const id = courseRecordId(game, n)
  if (!id) return
  await addRecord(game, id, name, value, device).catch((err: unknown) => {
    console.warn(`[course records] ${game} ${id} for ${name}:`, err)
  })
}

/** A lap saved to today's Hot Lap board (routes.ts), into today's track's book: a million less its milliseconds. */
export async function noteDayLap(name: string, score: number, device: DeviceType, at = Date.now()): Promise<void> {
  const day = dayNumberOf(boardDateKey(at))
  if (day < 1) return
  await noteCourseRecord('hotlap', trackOfDay(day), name, TIME_SCORE_BASE - score, device)
}

/** Today's Hole's result as it goes on the day's board (dailyHole.ts), into the hole's book. */
export async function noteDayHole(name: string, tries: number, device: DeviceType, now = Date.now()): Promise<void> {
  await noteCourseRecord('acechase', holeNumber(holeToday(now)), name, tries, device)
}

/**
 * Every track's and hole's board into its record book, for what was set before the books kept them: each
 * player's best, at the time it was set. Only a best the book hasn't got goes in, so it's safe to run at
 * every start. How many went in.
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
  const holes = Math.min(holeNumber(holeToday(now)), holeCount())
  for (let n = 1; n <= holes; n++) {
    const id = courseRecordId('acechase', n)
    if (!id) continue
    for (const e of await holeBoard('acechase', holeDay(n))) {
      if (await seedRecordEntry('acechase', id, { name: e.name, score: e.tries, at: e.at, device: e.device })) added++
    }
  }
  return added
}
