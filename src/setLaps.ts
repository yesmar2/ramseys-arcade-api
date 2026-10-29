import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { setLaps } from './db/schema.js'

/*
 * Platinum set by an admin's own lap (Ramsey, 2026-10-29: "i drive upcoming days and my best + 0.5s becomes
 * platinum"). Worked-out platinums couldn't stay consistent: his best on a track swung from 13.6% under the estimate
 * to 3% over, with how many tries he took and on what. So an admin test-drives a course from the admin page (the
 * site's Set platinum section, through each race's test run), each finished run's time comes here, the best one is
 * kept, and that course's platinum is it and half a second more. A course nobody has driven keeps its worked-out
 * platinum (trackLaps.ts coursePlatinum).
 *
 * The laps are read once at boot and every minute after, so the platinum a ladder or a medal count asks for
 * (trackLaps.ts coursePlatinum, sync) is always to hand. A write here is seen at once on this server.
 */

/** Platinum is the set lap and this much more: "my best + 0.5s". */
export const SET_LAP_SLACK_MS = 500

export type SetLap = { game: string; course: number; ms: number; at: number; by: string | null }

let kept = new Map<string, SetLap>()
let timer: NodeJS.Timeout | null = null

const keyOf = (game: string, course: number) => `${game}:${course}`

/** The set lap on a course, in ms, if an admin has driven it. */
export function setLapOf(game: string, course: number): number | null {
  return kept.get(keyOf(game, course))?.ms ?? null
}

/** Every set lap, by game and course. */
export function allSetLaps(): SetLap[] {
  return [...kept.values()].sort((a, b) => a.game.localeCompare(b.game) || a.course - b.course)
}

/** Read the laps again from the table. */
export async function loadSetLaps(): Promise<void> {
  const rows = await db().select().from(setLaps)
  kept = new Map(rows.map((r) => [keyOf(r.game, r.course), { game: r.game, course: r.course, ms: r.ms, at: r.at, by: r.by }]))
}

/** Read them now and every minute after, so another server's writes come through. */
export async function startSetLaps(): Promise<void> {
  await loadSetLaps().catch((err) => console.error('[setLaps] load failed', err))
  if (timer) return
  timer = setInterval(() => loadSetLaps().catch((err) => console.error('[setLaps] reload failed', err)), 60_000)
  timer.unref()
}

/**
 * A finished test run on a course: kept when it beats the course's set lap (or there's none). Says the set lap
 * after it, and whether this one took its place.
 */
export async function recordSetLap(game: string, course: number, ms: number, by: string, now = Date.now()): Promise<{ ms: number; improved: boolean }> {
  const had = setLapOf(game, course)
  if (had != null && had <= ms) return { ms: had, improved: false }
  const row = { game, course, ms, at: now, by }
  await db()
    .insert(setLaps)
    .values(row)
    .onConflictDoUpdate({ target: [setLaps.game, setLaps.course], set: { ms, at: now, by } })
  kept.set(keyOf(game, course), row)
  return { ms, improved: true }
}

/** A course's set lap gone, so its platinum is worked out again; false when it had none. */
export async function clearSetLap(game: string, course: number): Promise<boolean> {
  const gone = await db()
    .delete(setLaps)
    .where(and(eq(setLaps.game, game), eq(setLaps.course, course)))
    .returning({ game: setLaps.game })
  kept.delete(keyOf(game, course))
  return gone.length > 0
}
