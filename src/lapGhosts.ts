import { and, eq, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { lapGhosts } from './db/schema.js'
import { TIME_SCORE_BASE } from './scoreLimits.js'
import type { GameSlug } from './store.js'
import { trackBoard, trackState } from './trackLaps.js'

/*
 * The ghost of each Hot Lap track's #1, for everyone to race: today's #1 on today's track, a past track's
 * record holder on a past one. The site sends a lap's path once the lap is saved, and it's kept when the lap
 * is its tag's best on the track's board, to the millisecond, and faster than the ghost kept so far. A path
 * is where the car was ten times a second from the lights: x, y and heading, one after another. The #1
 * is always told, path or not: a lap saved before laps sent their paths, or from an old copy of the site,
 * has none, and the site then drives the blue car's line at the #1's time.
 *
 * Marble Run's courses have theirs the same way: a course's #1 on its board (trackLaps.ts), today's on today's
 * course, its All time #1 on a past one. Its path is where the marble was ten times a second from the go, x, y
 * (height) and z, with the goal's moment last, falls and all: a fall puts it back at a checkpoint.
 *
 * Lander's caves have theirs the same way: a cave's #1 on its board. Its path is where
 * the ship was ten times a second from the go, x, y, its angle and its engine (0 off, 1 on, 2 a wreck after a
 * crash), with the landing's moment last, crashes and all: a crash puts it back at a gate.
 */

/** The games whose #1 races as a ghost: Hot Lap's tracks, Marble Run's courses, and Lander's caves. */
export const GHOST_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['hotlap', 'marblerun', 'lander'])

/** Where a game's track, course or cave stands today (trackLaps.ts trackState). */
export function ghostState(game: GameSlug, n: number, now = Date.now()): 'past' | 'today' | 'ahead' | 'none' {
  return trackState(n, now, game)
}

/** A track's, course's or cave's board: each player's best, best first. */
function ghostBoard(game: GameSlug, n: number): Promise<{ name: string; score: number }[]> {
  return trackBoard(game, n)
}

/** Samples a second in a kept path. */
export const GHOST_RATE = 10
/** Ten minutes of lap, far longer than any. */
const MOST_SAMPLES = 6000
/** Metres a car can go between two samples: a tenth of a second at far more than its top speed. */
const MOST_STEP = 15
/** Metres a marble can go between two samples: a tenth of a second at far more than it ever rolls. */
const MARBLE_STEP = 8
/** Farther than that is a fall, back to a checkpoint: a run with more than this many isn't one. */
const MOST_FALLS = 60
/** Lines across a course: its checkpoints and the goal. */
const MOST_LINES = 12
/** Metres a ship can go between two samples: a tenth of a second at far more than it can fly in a cave. */
const SHIP_STEP = 8
/** Farther than that is a crash, back to a gate: a run with more than this many isn't one. */
const MOST_CRASHES = 200

export type LapGhost = { name: string; timeMs: number; splits: number[]; path: number[]; at: number; skin?: string }

/** Why a lap's (or a marble run's) splits and path can't be one of `timeMs`, or null if they can. */
export function ghostProblem(game: GameSlug, timeMs: number, splits: unknown, path: unknown): string | null {
  if (game === 'marblerun') return runProblem(timeMs, splits, path)
  if (game === 'lander') return flightProblem(timeMs, splits, path)
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

/**
 * Why a marble run's splits and path can't be a run of `timeMs`, or null if they can. Its splits are the
 * moment it crossed each checkpoint and the goal, in order (a line jumped over is crossed with the next);
 * its path is ten samples a second from the go, and the goal's moment last.
 */
function runProblem(timeMs: number, splits: unknown, path: unknown): string | null {
  const time = timeMs / 1000
  if (
    !Array.isArray(splits) ||
    splits.length < 1 ||
    splits.length > MOST_LINES ||
    !splits.every((s) => typeof s === 'number' && Number.isFinite(s))
  ) {
    return 'splits'
  }
  const at = splits as number[]
  if (!(at[0]! > 0) || at.some((s, k) => k > 0 && s < at[k - 1]!) || Math.abs(at.at(-1)! - time) > 0.05) return 'splits'
  if (!Array.isArray(path) || path.length % 3 !== 0 || !path.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'path'
  }
  const samples = path.length / 3
  if (samples > MOST_SAMPLES || samples < Math.floor(time * GHOST_RATE) || samples > Math.ceil(time * GHOST_RATE) + 2) {
    return 'length'
  }
  const p = path as number[]
  let falls = 0
  for (let k = 0; k < samples; k++) {
    if (Math.abs(p[k * 3]!) > 20_000 || Math.abs(p[k * 3 + 1]!) > 5_000 || Math.abs(p[k * 3 + 2]!) > 20_000) return 'range'
    if (k > 0 && Math.hypot(p[k * 3]! - p[k * 3 - 3]!, p[k * 3 + 1]! - p[k * 3 - 2]!, p[k * 3 + 2]! - p[k * 3 - 1]!) > MARBLE_STEP) {
      falls += 1
    }
  }
  return falls > MOST_FALLS ? 'step' : null
}

/**
 * Why a Lander run's splits and path can't be a run of `timeMs`, or null if they can. Its splits are the
 * moment it passed each gate and landed, in order; its path is ten samples a second from the go of x, y, the
 * ship's angle and its engine (0, 1, or 2 for a wreck), and the landing's moment last.
 */
function flightProblem(timeMs: number, splits: unknown, path: unknown): string | null {
  const time = timeMs / 1000
  if (
    !Array.isArray(splits) ||
    splits.length < 1 ||
    splits.length > MOST_LINES ||
    !splits.every((s) => typeof s === 'number' && Number.isFinite(s))
  ) {
    return 'splits'
  }
  const at = splits as number[]
  if (!(at[0]! > 0) || at.some((s, k) => k > 0 && s < at[k - 1]!) || Math.abs(at.at(-1)! - time) > 0.05) return 'splits'
  if (!Array.isArray(path) || path.length % 4 !== 0 || !path.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'path'
  }
  const samples = path.length / 4
  if (samples > MOST_SAMPLES || samples < Math.floor(time * GHOST_RATE) || samples > Math.ceil(time * GHOST_RATE) + 2) {
    return 'length'
  }
  const p = path as number[]
  let crashes = 0
  for (let k = 0; k < samples; k++) {
    const e = p[k * 4 + 3]!
    if (Math.abs(p[k * 4]!) > 5_000 || Math.abs(p[k * 4 + 1]!) > 5_000 || Math.abs(p[k * 4 + 2]!) > 10 || (e !== 0 && e !== 1 && e !== 2)) {
      return 'range'
    }
    if (k > 0 && Math.hypot(p[k * 4]! - p[k * 4 - 4]!, p[k * 4 + 1]! - p[k * 4 - 3]!) > SHIP_STEP) crashes += 1
  }
  return crashes > MOST_CRASHES ? 'step' : null
}

/** The track's (or course's) #1, and their lap's path if it came with one. Null while nobody has a lap on it. */
export async function ghostFor(
  game: GameSlug,
  track: number,
): Promise<{ name: string; timeMs: number; ghost: LapGhost | null } | null> {
  const board = await ghostBoard(game, track)
  const top = board[0]
  if (!top) return null
  const timeMs = TIME_SCORE_BASE - top.score
  const [row] = await db()
    .select()
    .from(lapGhosts)
    .where(and(eq(lapGhosts.game, game), eq(lapGhosts.track, track)))
    .limit(1)
  const theirs = row && row.name === top.name && row.timeMs === timeMs
  return {
    name: top.name,
    timeMs,
    ghost: theirs
      ? { name: row.name, timeMs: row.timeMs, splits: row.splits as number[], path: row.path as number[], at: row.at, ...(row.skin ? { skin: row.skin } : {}) }
      : null,
  }
}

/**
 * Keep a lap's ghost if it's the track's fastest yet. `names` are the tags the sender plays under: the lap
 * must be the best on the board under one of them, to the millisecond. Answers whether it was kept.
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
  skin?: string | null
  now?: number
}): Promise<boolean> {
  if (!input.names.includes(input.name)) return false
  const board = await ghostBoard(input.game, input.track)
  // The tag's lap on the board: a slower lap of theirs would be a ghost the board doesn't show.
  const onBoard = (name: string, timeMs: number) => board.some((e) => e.name === name && e.score === TIME_SCORE_BASE - timeMs)
  if (!onBoard(input.name, input.timeMs)) return false
  // A ghost that's no longer its tag's lap on the board (beaten since, a tag banned, a lap taken off) gives way to any lap.
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
      skin: input.skin ?? null,
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
        skin: input.skin ?? null,
        at: now,
      },
      // Only a faster lap takes the ghost's place; a tie leaves the one that got there first.
      setWhere: sql`${lapGhosts.timeMs} > excluded.time_ms`,
    })
    .returning({ name: lapGhosts.name })
  return kept.length > 0
}
