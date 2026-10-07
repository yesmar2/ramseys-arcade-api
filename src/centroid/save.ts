import { z } from 'zod'
import { CENTROID_FIRST_DAY } from './launch.js'
import { PLATES, dayPlan } from './plan.js'
import { judgeTaps, tapsFit } from './score.js'

/*
 * A Centroid day as it's saved (routes.ts): the day and the six taps the player made, never a score to be
 * taken on trust. The API deals the day's plates again (plan.ts, the site's own code) and works the score
 * out itself, exactly as the site did, so a forged figure can't reach the board.
 */

const tapSchema = z.object({ x: z.number(), y: z.number() })

export const platesSchema = z.object({
  /** The day the plates were played on, YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Each plate's tap on the table (a unit square), plate by plate. */
  taps: z.array(tapSchema).length(PLATES),
})

export type SavedPlates = z.infer<typeof platesSchema>

export type JudgedPlates = { ok: true; board: number } | { ok: false }

/** The day's board figure from its taps, or not ok for taps that can't be a run of that day. */
export function judgePlates(plates: SavedPlates): JudgedPlates {
  if (plates.day < CENTROID_FIRST_DAY) return { ok: false }
  const at = Date.parse(`${plates.day}T12:00:00Z`)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== plates.day) return { ok: false }
  if (!tapsFit(plates.taps)) return { ok: false }
  let plan
  try {
    plan = dayPlan(plates.day)
  } catch {
    return { ok: false }
  }
  const { board } = judgeTaps(plan, plates.taps)
  return { ok: true, board }
}

/**
 * The least time six plates can take, with the run's own clock a little behind the server's: each plate
 * comes on (0.4 s) before its pin can go in, and stands a moment after (1.25 s) before the next.
 */
export function minPlatesMs(): number {
  return 0.9 * PLATES * 1_200
}
