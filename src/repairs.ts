import { and, eq, gt, gte, inArray, like } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, leaderboardScores } from './db/schema.js'
import { seedScoreCap, TIME_SCORE_BASE, TIME_SCORED_GAMES } from './scoreLimits.js'

/**
 * One-time fixes to data that is already in the database, run at boot and
 * recorded in app_meta so each runs once per environment. Unlike the seed
 * revision these are narrow and meant for production too: they remove or
 * correct rows that could never have been real.
 */
type Repair = {
  id: string
  run: () => Promise<string>
}

const REPAIRS: Repair[] = [
  {
    // The world seed jittered elite time-scored runs above the base, so the
    // Find the Bug and Spotter boards were led by clears in negative time.
    id: '2026-09-21-impossible-times',
    run: async () => {
      const gone = await db()
        .delete(leaderboardScores)
        .where(
          and(
            inArray(leaderboardScores.game, [...TIME_SCORED_GAMES]),
            gte(leaderboardScores.score, TIME_SCORE_BASE),
          ),
        )
        .returning({ id: leaderboardScores.id })
      return `removed ${gone.length} time-scored rows at or above the base`
    },
  },
  {
    // The same jitter left seeded runs just under the base: one-second sweeps
    // of Find the Bug. Only sample rows go; a real player's time stays.
    id: '2026-09-21-seeded-superhuman-times',
    run: async () => {
      let removed = 0
      for (const game of TIME_SCORED_GAMES) {
        const gone = await db()
          .delete(leaderboardScores)
          .where(
            and(
              eq(leaderboardScores.game, game),
              like(leaderboardScores.id, 'seed-lb-%'),
              gt(leaderboardScores.score, seedScoreCap(game)),
            ),
          )
          .returning({ id: leaderboardScores.id })
        removed += gone.length
      }
      return `removed ${removed} seeded time-scored rows above their band`
    },
  },
]

export async function applyDataRepairs(): Promise<void> {
  for (const repair of REPAIRS) {
    const key = `repair:${repair.id}`
    const done = await db().select().from(appMeta).where(eq(appMeta.key, key)).limit(1)
    if (done[0]) continue
    const note = await repair.run()
    const stamp = new Date().toISOString()
    await db()
      .insert(appMeta)
      .values({ key, value: stamp })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: stamp } })
    console.log(`[repair] ${repair.id}: ${note}`)
  }
}
