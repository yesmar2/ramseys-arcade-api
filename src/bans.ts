import { desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, nameBans, nameClaims, recordScores } from './db/schema.js'
import { invalidateRecordHistoryCache } from './records.js'
import { invalidateSiteRecords } from './siteRecords.js'
import { invalidateHistoryCache } from './store.js'

export type BanRow = {
  name: string
  accountId: string | null
  reason: string | null
  bannedBy: string
  bannedAt: number
}

function clean(name: string) {
  return name.trim().slice(0, 12).toUpperCase()
}

/**
 * Is this player barred?
 *
 * Checks the tag and the account together, so somebody who claims a fresh tag
 * after being banned is still stopped by the account behind it.
 */
export async function isBanned(
  name: string,
  accountId: string | null | undefined,
): Promise<boolean> {
  const cleaned = clean(name)
  const clauses = [eq(nameBans.name, cleaned)]
  if (accountId) clauses.push(eq(nameBans.accountId, accountId))
  const [row] = await db()
    .select({ name: nameBans.name })
    .from(nameBans)
    .where(or(...clauses))
    .limit(1)
  return Boolean(row)
}

/** Bar a tag, recording the account that held it so a new tag will not help. */
export async function banName(
  name: string,
  detail: { reason?: string | null; bannedBy: string },
): Promise<BanRow> {
  const cleaned = clean(name)
  const [claim] = await db()
    .select({ accountId: nameClaims.accountId })
    .from(nameClaims)
    .where(eq(nameClaims.name, cleaned))
    .limit(1)

  const row = {
    name: cleaned,
    accountId: claim?.accountId ?? null,
    reason: detail.reason?.slice(0, 500) ?? null,
    bannedBy: detail.bannedBy,
    bannedAt: Date.now(),
  }

  await db()
    .insert(nameBans)
    .values(row)
    .onConflictDoUpdate({
      target: nameBans.name,
      set: {
        accountId: row.accountId,
        reason: row.reason,
        bannedBy: row.bannedBy,
        bannedAt: row.bannedAt,
      },
    })
  return row
}

export async function unbanName(name: string): Promise<boolean> {
  const removed = await db()
    .delete(nameBans)
    .where(eq(nameBans.name, clean(name)))
    .returning({ name: nameBans.name })
  return removed.length > 0
}

export async function listBans(): Promise<BanRow[]> {
  const rows = await db().select().from(nameBans).orderBy(desc(nameBans.bannedAt))
  return rows.map((row) => ({
    name: row.name,
    accountId: row.accountId,
    reason: row.reason,
    bannedBy: row.bannedBy,
    bannedAt: Number(row.bannedAt),
  }))
}

/**
 * Wipe a tag's scores from the boards and the record books.
 *
 * Trophies already awarded are left alone on purpose — they are a record of
 * what a season's board said at the time, and quietly rewriting history is a
 * different decision from taking a cheat off the board today.
 */
export async function purgeName(name: string): Promise<{
  leaderboard: number
  records: number
}> {
  const cleaned = clean(name)
  const boards = await db()
    .delete(leaderboardScores)
    .where(eq(leaderboardScores.name, cleaned))
    .returning({ id: leaderboardScores.id })
  const books = await db()
    .delete(recordScores)
    .where(eq(recordScores.name, cleaned))
    .returning({ id: recordScores.id })
  // Boards and books are served from caches; without this the purged scores stay up.
  invalidateHistoryCache()
  invalidateRecordHistoryCache()
  invalidateSiteRecords()
  return { leaderboard: boards.length, records: books.length }
}

/** Remove single scores by id. Returns how many actually existed. */
export async function voidScores(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const removed = await db()
    .delete(leaderboardScores)
    .where(inArray(leaderboardScores.id, ids))
    .returning({ id: leaderboardScores.id })
  /*
   * The board is read through a cache that only writes invalidate. Deleting
   * straight from the table left the voided score sitting on the leaderboard
   * until the cache aged out — the row was gone and the site still showed it.
   */
  invalidateHistoryCache()
  invalidateSiteRecords()
  return removed.length
}

export type ScoreRow = {
  id: string
  game: string
  name: string
  score: number
  at: number
  device: string
  runId: string | null
  durationMs: number | null
  ipHash: string | null
  userAgent: string | null
}

/** Recent scores with their audit trail, for deciding whether one is real. */
export async function recentScores(filter: {
  game?: string
  name?: string
  limit: number
}): Promise<ScoreRow[]> {
  const rows = await db()
    .select()
    .from(leaderboardScores)
    .where(
      sql`(${filter.game ?? null}::text IS NULL OR ${leaderboardScores.game} = ${filter.game ?? null})
          AND (${filter.name ? clean(filter.name) : null}::text IS NULL OR ${leaderboardScores.name} = ${filter.name ? clean(filter.name) : null})`,
    )
    .orderBy(desc(leaderboardScores.at))
    .limit(filter.limit)

  return rows.map((row) => ({
    id: row.id,
    game: row.game,
    name: row.name,
    score: row.score,
    at: Number(row.at),
    device: row.device,
    runId: row.runId,
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    ipHash: row.ipHash,
    userAgent: row.userAgent,
  }))
}
