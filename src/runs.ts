import crypto from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { gameRuns, runClaims } from './db/schema.js'
import type { GameSlug } from './store.js'

function newRunId() {
  return crypto.randomBytes(18).toString('base64url')
}

/**
 * How long a run id stays good.
 *
 * Long enough that nobody loses a genuine marathon session to it, short enough
 * that a stockpile of ids cannot be banked for later. A run left open past this
 * is simply not redeemable — the player starts a new one.
 */
const RUN_TTL_MS = 6 * 60 * 60 * 1000

/** Spent and expired rows are swept opportunistically, on roughly 1 start in 50. */
const SWEEP_ODDS = 0.02
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000

export type RunTicket = { runId: string; startedAt: number }

/** Open a run: the server writes down when it began, and hands back the id. */
export async function startRun(
  accountId: string | null,
  game: GameSlug,
): Promise<RunTicket> {
  const runId = newRunId()
  const startedAt = Date.now()
  await db().insert(gameRuns).values({ id: runId, accountId, game, startedAt })
  if (Math.random() < SWEEP_ODDS) void sweepOldRuns()
  return { runId, startedAt }
}

export type RunCode = 'UNKNOWN' | 'USED' | 'EXPIRED' | 'MISMATCH'

export type RunLookup =
  | { ok: true; startedAt: number; elapsedMs: number }
  | { ok: false; code: RunCode }

/**
 * Read a run, returning how long it has been open.
 *
 * Says nothing about whether the run has already paid out — one run feeds the
 * board, the tournaments that include the game and the record books, so "has
 * this been used" only means something once you say what for. That is
 * {@link claimRun}.
 */
export async function peekRun(
  runId: string,
  accountId: string,
  game: GameSlug,
): Promise<RunLookup> {
  const now = Date.now()
  const [run] = await db().select().from(gameRuns).where(eq(gameRuns.id, runId)).limit(1)
  if (!run) return { ok: false, code: 'UNKNOWN' }
  if (run.game !== game) return { ok: false, code: 'MISMATCH' }
  // A run opened while signed out belongs to whoever signs in and saves it.
  if (run.accountId != null && run.accountId !== accountId) {
    return { ok: false, code: 'MISMATCH' }
  }
  if (now - run.startedAt > RUN_TTL_MS) return { ok: false, code: 'EXPIRED' }
  return { ok: true, startedAt: run.startedAt, elapsedMs: now - run.startedAt }
}

export type RunSurface = 'leaderboard' | 'tournament'

/**
 * Cash a run in for one surface. False means it already has been.
 *
 * The insert is the lock: the primary key on (run, surface, ref) means two
 * submissions racing the same surface cannot both land, and the loser is
 * simply a duplicate. Call it last, once everything that could reject the
 * score has had its say, so a rejection never costs the player their run.
 */
export async function claimRun(
  runId: string,
  surface: RunSurface,
  ref = '',
): Promise<boolean> {
  const claimed = await db()
    .insert(runClaims)
    .values({ runId, surface, ref, claimedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ runId: runClaims.runId })
  return claimed.length > 0
}

/** Drop rows no submission can still reference. */
export async function sweepOldRuns(): Promise<void> {
  const cutoff = Date.now() - SWEEP_AFTER_MS
  try {
    await db().delete(gameRuns).where(lt(gameRuns.startedAt, cutoff))
    // Claims outlive nothing useful once the run they name is gone.
    await db().delete(runClaims).where(lt(runClaims.claimedAt, cutoff))
  } catch (err) {
    console.error('[runs] sweep failed', err)
  }
}

/**
 * Runs this account opened in the last hour.
 *
 * Used only to bound how many rows one account can write; the limiter in front
 * of the route does the real work.
 */
export async function recentRunCount(accountId: string, sinceMs: number): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(gameRuns)
    .where(and(eq(gameRuns.accountId, accountId), sql`${gameRuns.startedAt} >= ${sinceMs}`))
  return row?.n ?? 0
}
