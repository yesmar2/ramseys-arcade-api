import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, recordScores, tournaments } from './db/schema.js'

/**
 * One-time: drop obsolete Frogger Crosswalk boards, then promote Stride → Crosswalk.
 * Safe to re-run — only acts while any `stride` leaderboard/record rows remain.
 */
export async function migrateStrideToCrosswalk() {
  const leftover = await db()
    .select({ id: leaderboardScores.id })
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, 'stride'))
    .limit(1)
  const leftoverRecords = await db()
    .select({ id: recordScores.id })
    .from(recordScores)
    .where(eq(recordScores.game, 'stride'))
    .limit(1)
  if (!leftover.length && !leftoverRecords.length) return false

  await db().transaction(async (tx) => {
    await tx.delete(leaderboardScores).where(eq(leaderboardScores.game, 'crosswalk'))
    await tx.delete(recordScores).where(eq(recordScores.game, 'crosswalk'))
    await tx
      .update(leaderboardScores)
      .set({ game: 'crosswalk' })
      .where(eq(leaderboardScores.game, 'stride'))
    await tx
      .update(recordScores)
      .set({ game: 'crosswalk' })
      .where(eq(recordScores.game, 'stride'))
  })

  // Tournament JSON may still list `stride` or score against it.
  const rows = await db().select().from(tournaments)
  for (const row of rows) {
    const data = row.data as {
      games?: string[]
      scores?: Array<{ game?: string }>
      attempts?: Array<{ game?: string }>
    } | null
    if (!data || typeof data !== 'object') continue
    let changed = false
    if (Array.isArray(data.games) && data.games.includes('stride')) {
      data.games = [...new Set(data.games.map((g) => (g === 'stride' ? 'crosswalk' : g)))]
      changed = true
    }
    if (Array.isArray(data.scores)) {
      for (const s of data.scores) {
        if (s?.game === 'stride') {
          s.game = 'crosswalk'
          changed = true
        }
      }
    }
    if (Array.isArray(data.attempts)) {
      for (const a of data.attempts) {
        if (a?.game === 'stride') {
          a.game = 'crosswalk'
          changed = true
        }
      }
    }
    if (changed) {
      await db()
        .update(tournaments)
        .set({ data })
        .where(eq(tournaments.id, row.id))
    }
  }

  console.log('[migrate] stride → crosswalk (cleared legacy frogger crosswalk boards)')
  return true
}
