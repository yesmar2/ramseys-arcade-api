import crypto from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, scoreFlags } from './db/schema.js'
import { rateAllowance } from './scoreLimits.js'
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

/** Past this multiple of the best existing score, a run wants explaining. */
const OUTLIER_MULTIPLE = 2.5

/** A score using this much of what the elapsed time allowed is at the edge. */
const NEAR_CAP_FRACTION = 0.85

/** Below this, a board is too thin for "far past the rest" to mean anything. */
const MIN_BOARD_FOR_OUTLIER = 5

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
  },
  bestBefore: number,
): Promise<void> {
  try {
    if (
      bestBefore > 0 &&
      entry.score > bestBefore * OUTLIER_MULTIPLE &&
      (await boardDepth(entry.game)) >= MIN_BOARD_FOR_OUTLIER
    ) {
      await record({
        ...entry,
        kind: 'outlier',
        detail: `${(entry.score / bestBefore).toFixed(1)}x the previous best of ${bestBefore}`,
      })
      return
    }

    if (entry.durationMs != null) {
      const allowed = rateAllowance(entry.game, entry.durationMs)
      if (allowed != null && allowed > 0 && entry.score >= allowed * NEAR_CAP_FRACTION) {
        await record({
          ...entry,
          kind: 'near-cap',
          detail: `used ${Math.round((entry.score / allowed) * 100)}% of what ${(entry.durationMs / 1000).toFixed(1)}s allows`,
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
