import { z } from 'zod'
import { HALFFULL_FIRST_DAY } from './launch.js'
import { HALF_ROUNDS, ROUNDS, dayPlan } from './plan.js'
import { judgeLevels, levelsFit } from './score.js'

/*
 * A Half Full day as it's saved (routes.ts): the day and the five levels the player locked, never a score
 * to be taken on trust. The API builds the day's glasses again (plan.ts, the site's own code) and works
 * the score out itself, exactly as the site did, so a forged figure can't reach the board.
 */

export const poursSchema = z.object({
  /** The day the glasses were poured on, YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Each glass's locked level, 0..1000; the fifth is the split's tall glass's. */
  levels: z.array(z.number().int()).length(ROUNDS),
  /** Which of them the 30-second clock locked, rather than the player. */
  auto: z.array(z.boolean()).length(ROUNDS).optional(),
})

export type Pours = z.infer<typeof poursSchema>

export type JudgedPours = { ok: true; board: number } | { ok: false }

/**
 * The day's board figure from its pours, or not ok for pours that can't be a run of that day: a day before
 * the first, levels out of their glasses, a glass the player locked empty, or a day that scores nothing.
 */
export function judgePours(pours: Pours): JudgedPours {
  if (pours.day < HALFFULL_FIRST_DAY) return { ok: false }
  const at = Date.parse(`${pours.day}T12:00:00Z`)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== pours.day) return { ok: false }
  let plan
  try {
    plan = dayPlan(pours.day)
  } catch {
    return { ok: false }
  }
  if (!levelsFit(plan, pours.levels)) return { ok: false }
  // "That's half" won't lock an empty glass; only the clock can (game.ts canLock).
  for (let round = 0; round < HALF_ROUNDS; round++) {
    if (pours.levels[round] === 0 && pours.auto?.[round] !== true) return { ok: false }
  }
  const { board } = judgeLevels(plan, pours.levels)
  return board > 0 ? { ok: true, board } : { ok: false }
}

/**
 * The least time five pours can take, with the run's own clock a little behind the server's: a glass's lock
 * waits 1.2 s after it comes in, and one the clock locked took its 30 s.
 */
export function minPourMs(auto: readonly boolean[] | undefined): number {
  let ms = 0
  for (let round = 0; round < ROUNDS; round++) ms += auto?.[round] ? 30_000 : 1_200
  return 0.9 * ms
}
