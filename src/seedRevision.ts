import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, leaderboardScores, recordScores, trophyAwards, trophyCursor } from './db/schema.js'

/**
 * Bump this to wipe leaderboards/records/trophies on the next API boot.
 * Keeps accounts, sessions, and name claims. Does not re-add sample scores.
 */
export const SEED_REVISION = '2026-09-10-postgres'

async function readRev(): Promise<string | null> {
  const rows = await db()
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, 'seed_revision'))
    .limit(1)
  return rows[0]?.value ?? null
}

async function writeRev(rev: string) {
  await db()
    .insert(appMeta)
    .values({ key: 'seed_revision', value: rev })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: rev },
    })
}

async function clearBoardsAndRecords() {
  await db().delete(leaderboardScores)
  await db().delete(recordScores)
  await db().delete(trophyAwards)
  await db()
    .insert(trophyCursor)
    .values({
      id: 'default',
      weeklyInitialized: false,
      monthlyInitialized: false,
    })
    .onConflictDoUpdate({
      target: trophyCursor.id,
      set: { weeklyInitialized: false, monthlyInitialized: false },
    })
}

/** Wipe sample boards when {@link SEED_REVISION} changes (or SEED_FORCE). */
export async function applySeedRevision(forceEnv = false): Promise<boolean> {
  const force = forceEnv || process.env.SEED_FORCE === '1' || process.env.SEED_FORCE === 'true'
  const current = await readRev()
  if (!force && current === SEED_REVISION) return false

  await clearBoardsAndRecords()
  await writeRev(SEED_REVISION)
  return true
}
