import { and, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { lapGhosts } from './db/schema.js'
import { TIME_SCORE_BASE } from './scoreLimits.js'
import type { GameSlug } from './store.js'
import { trackBoard } from './trackLaps.js'

/*
 * The ghost of the fastest lap on each Hot Lap track, for everyone to race: today's #1 on today's track,
 * a past track's record holder on a past one. The site sends a lap's path once the lap is saved; it's kept
 * when its tag is on the track's board with a lap at least that fast, and it beats the ghost kept so far. A
 * path is where the car was ten times a second from the lights: x, y and heading, one after another.
 */

/** Samples a second in a kept path. */
export const GHOST_RATE = 10
/** Ten minutes of lap, far longer than any. */
const MOST_SAMPLES = 6000
/** Metres a car can go between two samples: a tenth of a second at far more than its top speed. */
const MOST_STEP = 15

export type LapGhost = { name: string; timeMs: number; splits: number[]; path: number[]; at: number }

/** Why a lap's splits and path can't be a lap of `timeMs`, or null if they can. */
export function ghostProblem(timeMs: number, splits: unknown, path: unknown): string | null {
  const time = timeMs / 1000
  if (!Array.isArray(splits) || splits.length !== 3 || !splits.every((s) => typeof s === 'number' && Number.isFinite(s))) {
    return 'splits'
  }
  const [a, b, c] = splits as number[]
  if (!(a! > 0 && b! > a! && c! > b!) || Math.abs(c! - time) > 0.05) return 'splits'
  if (!Array.isArray(path) || path.length % 3 !== 0 || !path.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'path'
  }
  const samples = path.length / 3
  // One at the lights, then ten a second until the line.
  if (samples > MOST_SAMPLES || samples < Math.floor(time * GHOST_RATE) - 1 || samples > Math.ceil(time * GHOST_RATE) + 2) {
    return 'length'
  }
  const p = path as number[]
  for (let k = 0; k < samples; k++) {
    if (Math.abs(p[k * 3]!) > 20_000 || Math.abs(p[k * 3 + 1]!) > 20_000 || Math.abs(p[k * 3 + 2]!) > 10_000) return 'range'
    if (k > 0 && Math.hypot(p[k * 3]! - p[k * 3 - 3]!, p[k * 3 + 1]! - p[k * 3 - 2]!) > MOST_STEP) return 'step'
  }
  return null
}

/** The track's ghost, while its tag is still on the track's board with a lap at least that fast. */
export async function ghostFor(game: GameSlug, track: number): Promise<LapGhost | null> {
  const [row] = await db()
    .select()
    .from(lapGhosts)
    .where(and(eq(lapGhosts.game, game), eq(lapGhosts.track, track)))
    .limit(1)
  if (!row) return null
  const board = await trackBoard(game, track)
  const entry = board.find((e) => e.name === row.name)
  if (!entry || entry.score < TIME_SCORE_BASE - row.timeMs) return null
  return { name: row.name, timeMs: row.timeMs, splits: row.splits as number[], path: row.path as number[], at: row.at }
}

/**
 * Keep a lap's ghost if it's the track's fastest yet. `names` are the tags the sender plays under: the lap
 * must be on the board under one of them, with that tag's best at least as fast. Answers whether it was kept.
 */
export async function keepGhost(input: {
  game: GameSlug
  track: number
  accountId: string
  names: string[]
  name: string
  timeMs: number
  splits: number[]
  path: number[]
  now?: number
}): Promise<boolean> {
  if (!input.names.includes(input.name)) return false
  const board = await trackBoard(input.game, input.track)
  const onBoard = (name: string, timeMs: number) => {
    const entry = board.find((e) => e.name === name)
    return entry != null && entry.score >= TIME_SCORE_BASE - timeMs
  }
  if (!onBoard(input.name, input.timeMs)) return false
  // A ghost whose lap has left the board (a tag banned, a lap taken off) gives way to any lap.
  const [held] = await db()
    .select({ name: lapGhosts.name, timeMs: lapGhosts.timeMs })
    .from(lapGhosts)
    .where(and(eq(lapGhosts.game, input.game), eq(lapGhosts.track, input.track)))
    .limit(1)
  if (held && !onBoard(held.name, held.timeMs)) {
    await db()
      .delete(lapGhosts)
      .where(and(eq(lapGhosts.game, input.game), eq(lapGhosts.track, input.track), eq(lapGhosts.name, held.name)))
  }
  const now = input.now ?? Date.now()
  const kept = await db()
    .insert(lapGhosts)
    .values({
      game: input.game,
      track: input.track,
      accountId: input.accountId,
      name: input.name,
      timeMs: input.timeMs,
      splits: input.splits,
      path: input.path,
      at: now,
    })
    .onConflictDoUpdate({
      target: [lapGhosts.game, lapGhosts.track],
      set: {
        accountId: input.accountId,
        name: input.name,
        timeMs: input.timeMs,
        splits: input.splits,
        path: input.path,
        at: now,
      },
      // Only a faster lap takes the ghost's place; a tie leaves the one that got there first.
      setWhere: sql`${lapGhosts.timeMs} > excluded.time_ms`,
    })
    .returning({ name: lapGhosts.name })
  return kept.length > 0
}
