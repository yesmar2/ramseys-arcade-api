import crypto from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, scoreFlags } from './db/schema.js'
import { rateAllowance, TIME_SCORE_BASE, TIME_SCORED_GAMES } from './scoreLimits.js'
import type { GameSlug } from './store.js'

/**
 * Notice a score that does not look right, and write it down.
 *
 * The caps in scoreLimits are loose on purpose — they reject the impossible,
 * not the improbable — which leaves a gap where a score is technically
 * allowed and still obviously wrong. Nothing was watching that gap: a cheated
 * score sat on the board until somebody happened to scroll past it.
 *
 * This never rejects anything. It records a suspicion for a person to settle,
 * because the alternative is a heuristic quietly throwing away real runs.
 */

/**
 * Past this multiple of the best existing score, a run wants explaining. It was 2.5 until 2026-10-16, which let
 * a patient fake twice the best (a run opened, left to run on, then a big score sent) through unnoticed; a flag
 * costs only a look, so it's lower now.
 */
const OUTLIER_MULTIPLE = 1.5

/** A score using this much of what the elapsed time allowed is at the edge. */
const NEAR_CAP_FRACTION = 0.85

/** Below this, a board is too thin for "far past the rest" to mean anything. */
const MIN_BOARD_FOR_OUTLIER = 5

/**
 * A time this far under the best before it wants explaining too: 15% faster than the board's best. A time is
 * never a multiple of another (a run 2.5 times as good would take no time at all), so the time-scored boards,
 * the races among them, went unwatched until 2026-10-16.
 */
const FAST_SHARE = 0.85

/** A time within this much of its floor (trackLaps.ts floorMsFor) is at the edge of what a board believes. */
const NEAR_FLOOR = 1.1

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

export type FlagKind = 'outlier' | 'near-cap'

export type NewFlag = {
  scoreId: string
  game: GameSlug
  name: string
  score: number
  kind: FlagKind
  detail: string
  runId?: string | null
  durationMs?: number | null
}

async function record(flag: NewFlag): Promise<void> {
  const row = {
    id: crypto.randomBytes(12).toString('base64url'),
    scoreId: flag.scoreId,
    game: flag.game,
    name: flag.name,
    score: flag.score,
    kind: flag.kind,
    detail: flag.detail,
    runId: flag.runId ?? null,
    durationMs: flag.durationMs ?? null,
    createdAt: Date.now(),
    reviewedAt: null,
  }
  await db().insert(scoreFlags).values(row)
  // Also shouted into the logs, so it is visible without opening the tools.
  console.warn(`[flag] ${flag.kind}: ${flag.name} scored ${flag.score} on ${flag.game} — ${flag.detail}`)
}

/**
 * Judge a score that has just been saved.
 *
 * `bestBefore` is the top of that board as it stood a moment ago — passed in
 * rather than looked up, because by now the new score is already on it.
 * Failures are swallowed: a flag is a note for later, and losing one is never
 * worth failing the save that earned it.
 */
export async function flagIfSuspicious(
  entry: {
    scoreId: string
    game: GameSlug
    name: string
    score: number
    runId?: string | null
    durationMs?: number | null
    /** The time its score was held to, with any late start the site reported (runs.ts runLag). */
    checkedMs?: number | null
  },
  bestBefore: number,
  board: {
    /** How many were on the board the best came from, for a time-scored game. */
    boardSize?: number
    /** The fastest the board believes, for a time-scored game (trackLaps.ts floorMsFor). */
    floorMs?: number | null
  } = {},
): Promise<void> {
  const { checkedMs, ...flagged } = entry
  try {
    if (TIME_SCORED_GAMES.has(entry.game)) {
      const ms = TIME_SCORE_BASE - entry.score
      const bestMs = bestBefore > 0 ? TIME_SCORE_BASE - bestBefore : null
      if (bestMs != null && ms < bestMs * FAST_SHARE && (board.boardSize ?? 0) >= MIN_BOARD_FOR_OUTLIER) {
        await record({
          ...flagged,
          kind: 'outlier',
          detail: `${seconds(ms)}, ${Math.round((1 - ms / bestMs) * 100)}% faster than the best before it, ${seconds(bestMs)}`,
        })
        return
      }
      if (board.floorMs != null && ms < board.floorMs * NEAR_FLOOR) {
        await record({
          ...flagged,
          kind: 'near-cap',
          detail: `${seconds(ms)}, within ${Math.round((NEAR_FLOOR - 1) * 100)}% of the fastest believed, ${seconds(board.floorMs)}`,
        })
      }
      return
    }

    if (
      bestBefore > 0 &&
      entry.score > bestBefore * OUTLIER_MULTIPLE &&
      (await boardDepth(entry.game)) >= MIN_BOARD_FOR_OUTLIER
    ) {
      await record({
        ...flagged,
        kind: 'outlier',
        detail: `${(entry.score / bestBefore).toFixed(1)}x the previous best of ${bestBefore}`,
      })
      return
    }

    const heldTo = checkedMs ?? entry.durationMs
    if (heldTo != null) {
      const allowed = rateAllowance(entry.game, heldTo)
      if (allowed != null && allowed > 0 && entry.score >= allowed * NEAR_CAP_FRACTION) {
        await record({
          ...flagged,
          kind: 'near-cap',
          detail: `used ${Math.round((entry.score / allowed) * 100)}% of what ${seconds(heldTo)} allows`,
        })
      }
    }
  } catch (err) {
    console.error('[flag] could not record', err)
  }
}

async function boardDepth(game: GameSlug): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, game))
  return row?.n ?? 0
}

export type FlagRow = {
  id: string
  scoreId: string
  game: string
  name: string
  score: number
  kind: string
  detail: string
  runId: string | null
  durationMs: number | null
  createdAt: number
  reviewedAt: number | null
}

export async function listFlags(opts: {
  limit: number
  includeReviewed: boolean
}): Promise<FlagRow[]> {
  const rows = await db()
    .select()
    .from(scoreFlags)
    .where(opts.includeReviewed ? sql`true` : isNull(scoreFlags.reviewedAt))
    .orderBy(desc(scoreFlags.createdAt))
    .limit(opts.limit)
  return rows.map((row) => ({
    ...row,
    score: row.score,
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
    createdAt: Number(row.createdAt),
    reviewedAt: row.reviewedAt == null ? null : Number(row.reviewedAt),
  }))
}

/** Mark a flag settled, whichever way it went. */
export async function reviewFlag(id: string): Promise<boolean> {
  const done = await db()
    .update(scoreFlags)
    .set({ reviewedAt: Date.now() })
    .where(and(eq(scoreFlags.id, id), isNull(scoreFlags.reviewedAt)))
    .returning({ id: scoreFlags.id })
  return done.length > 0
}

export async function unreviewedCount(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(scoreFlags)
    .where(isNull(scoreFlags.reviewedAt))
  return row?.n ?? 0
}
