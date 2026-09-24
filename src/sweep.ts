import { pushHeld } from './push.js'
import { sweepTournaments } from './tournaments.js'
import { ensurePeriodTrophies } from './trophies.js'

/**
 * What happens on the clock rather than when somebody asks: a bracket round
 * timing out and the next one opening, an event ending, a week or a month
 * closing, and pushes that quiet hours held back.
 *
 * All of it used to wait for a page load: match alerts went out when someone
 * happened to open the events, so a quiet night sent nothing. The API runs
 * this every few minutes while it's awake, and a scheduled ping keeps it
 * awake (.github/workflows/keep-awake.yml).
 */

const EVERY_MS = 5 * 60_000

let running: Promise<void> | null = null
let sweptAt: number | null = null

export async function sweep(): Promise<void> {
  if (running) return running
  running = (async () => {
    const steps: [string, () => Promise<unknown>][] = [
      ['events', () => sweepTournaments(Date.now())],
      ['trophies', () => ensurePeriodTrophies(Date.now())],
      ['pushes', () => pushHeld(Date.now())],
    ]
    for (const [name, step] of steps) {
      try {
        await step()
      } catch (err) {
        console.warn(`[sweep] ${name} failed:`, err)
      }
    }
    sweptAt = Date.now()
  })().finally(() => {
    running = null
  })
  return running
}

/** When the last sweep finished, for /health: proof the clock is running. */
export function lastSweptAt(): number | null {
  return sweptAt
}

export function startSweeping() {
  // A moment after boot, so the requests that woke the server aren't queued behind it.
  setTimeout(() => void sweep(), 15_000).unref()
  setInterval(() => void sweep(), EVERY_MS).unref()
}
