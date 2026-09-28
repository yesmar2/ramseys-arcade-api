import { holeBoard, holeCount, holeDay, holeNumber, holeToday } from './holes.js'
import { addRecord, courseOnDay, courseRecordId, FINDBUG_FIRST_DAY, seedRecordEntry } from './records.js'
import { TIME_SCORE_BASE } from './scoreLimits.js'
import { boardDateKey, dayPlayers, type DeviceType, type GameSlug } from './store.js'
import { dayNumberOf, trackBoard, trackCount, trackOfDay } from './trackLaps.js'

/*
 * Course records (records.ts): each Hot Lap track's, each Ace Chase hole's and each Find the Bug day's
 * record, in its game's record book. What goes in is what goes on the track's, hole's or day's own board
 * (trackLaps.ts, holes.ts; a Find the Bug day's is its day's, first runs only), as it goes on: a lap or
 * result on its day, and one on it since. What was set before the books kept them is put in once, at
 * start (syncCourseRecords), with no one told their record was taken.
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
 * lap into today's track's, and Find the Bug's first run into the day's. Both are timed: a million less
 * their milliseconds.
 */
export async function noteDayRun(game: GameSlug, name: string, score: number, device: DeviceType, at = Date.now()): Promise<void> {
  if (game === 'hotlap') {
    const day = dayNumberOf(boardDateKey(at))
    if (day >= 1) await noteCourseRecord('hotlap', trackOfDay(day), name, TIME_SCORE_BASE - score, device)
  } else if (game === 'findbug') {
    await noteCourseRecord('findbug', courseOnDay('findbug', boardDateKey(at)), name, TIME_SCORE_BASE - score, device)
  }
}

/** Today's Hole's result as it goes on the day's board (dailyHole.ts), into the hole's book. */
export async function noteDayHole(name: string, tries: number, device: DeviceType, now = Date.now()): Promise<void> {
  await noteCourseRecord('acechase', holeNumber(holeToday(now)), name, tries, device)
}

/** A Find the Bug day's number, as a day key (YYYYMMDD). */
function findbugDayKey(n: number): number {
  const [y, m, d] = FINDBUG_FIRST_DAY.split('-').map(Number)
  const at = new Date(Date.UTC(y!, m! - 1, d! + n - 1))
  return at.getUTCFullYear() * 10_000 + (at.getUTCMonth() + 1) * 100 + at.getUTCDate()
}

/**
 * Every track's, hole's and day's board into its record book, for what was set before the books kept
 * them: each player's best, at the time it was set. Only a best the book hasn't got goes in, so it's safe
 * to run at every start. How many went in.
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
  const bugDays = courseOnDay('findbug', boardDateKey(now))
  for (let n = 1; n <= bugDays; n++) {
    const id = courseRecordId('findbug', n)
    if (!id) continue
    // A day's board holds only first runs (firstRun.ts), each player's best that day.
    for (const e of await dayPlayers('findbug', findbugDayKey(n))) {
      if (await seedRecordEntry('findbug', id, { name: e.name, score: TIME_SCORE_BASE - e.score, at: e.at, device: e.device })) added++
    }
  }
  return added
}
