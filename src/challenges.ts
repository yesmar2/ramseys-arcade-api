import { randomInt } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { challengeResults, challenges, leaderboardScores } from './db/schema.js'
import { notify } from './notifications.js'
import { sendPush } from './push.js'
import { TIME_SCORE_BASE, TIME_SCORED_GAMES } from './scoreLimits.js'
import type { GameSlug } from './store.js'
import { GAME_LABELS } from './tournaments.js'

/**
 * Challenges: one saved run, sent to a friend to beat.
 *
 * A challenge is made from a run already on the boards, by the account that
 * owns its tag, so a link can only ever carry a score somebody really played.
 * A friend's run posted against it keeps their best go, and the challenger
 * hears about it: in the inbox when somebody tries, and on their phone as
 * well when somebody wins. The winning run is sent back as a challenge of
 * its own, so the answer is one tap away.
 */

export type ChallengeRow = typeof challenges.$inferSelect

/** No 0/O, 1/l/I: a code people may read out to each other. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
const ID_LENGTH = 7

function newChallengeId(): string {
  let id = ''
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
  return id
}

export function isChallengeId(id: string): boolean {
  return /^[A-Za-z0-9]{4,16}$/.test(id)
}

/* ---------- words, for the challenger's inbox ---------- */

const UNITS: Partial<Record<GameSlug, [string, string]>> = {
  crosswalk: ['row', 'rows'],
  stacker: ['block', 'blocks'],
  simon: ['round', 'rounds'],
  fireflies: ['note', 'notes'],
}

function isTime(game: GameSlug) {
  return TIME_SCORED_GAMES.has(game)
}

/** A time the way the site prints one: 47.5s, or 1:02.3 past a minute. */
function clock(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = total - m * 60
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`
}

/** A score as the board shows it: 447, 14,310, 47.5s. */
export function scoreFigure(game: GameSlug, score: number): string {
  return isTime(game) ? clock(TIME_SCORE_BASE - score) : score.toLocaleString('en-US')
}

/** A gap between two scores in the game's own terms: 6 rows, 1 point, 0.4s. */
function gapWords(game: GameSlug, gap: number): string {
  if (isTime(game)) return `${(gap / 1000).toFixed(1)}s`
  const [one, many] = UNITS[game] ?? ['point', 'points']
  return `${gap.toLocaleString('en-US')} ${gap === 1 ? one : many}`
}

function gameLabel(game: GameSlug): string {
  return GAME_LABELS[game] ?? game
}

/* ---------- making and reading ---------- */

export async function getChallenge(id: string): Promise<ChallengeRow | null> {
  if (!isChallengeId(id)) return null
  const [row] = await db().select().from(challenges).where(eq(challenges.id, id)).limit(1)
  return row ?? null
}

async function challengeForScore(scoreId: string): Promise<ChallengeRow | null> {
  const [row] = await db().select().from(challenges).where(eq(challenges.scoreId, scoreId)).limit(1)
  return row ?? null
}

/**
 * Make a challenge from a saved run. The run must be this tag's, on this game;
 * sending the same run twice sends the same challenge.
 */
export async function createChallenge(
  input: { game: GameSlug; name: string; accountId: string; scoreId: string; replyTo?: string | null },
  now = Date.now(),
): Promise<ChallengeRow> {
  const [run] = await db()
    .select()
    .from(leaderboardScores)
    .where(eq(leaderboardScores.id, input.scoreId))
    .limit(1)
  if (!run || run.game !== input.game || run.name !== input.name) {
    throw Object.assign(new Error('That run can’t be sent as a challenge'), {
      status: 404,
      code: 'RUN_NOT_FOUND',
    })
  }

  const existing = await challengeForScore(run.id)
  if (existing) return existing

  for (let attempt = 0; ; attempt++) {
    const row: ChallengeRow = {
      id: newChallengeId(),
      game: input.game,
      name: input.name,
      accountId: input.accountId,
      score: run.score,
      scoreId: run.id,
      replyTo: input.replyTo ?? null,
      createdAt: now,
    }
    try {
      await db().insert(challenges).values(row)
      return row
    } catch (err) {
      // The same run sent twice at once: the other request's challenge is this one.
      const raced = await challengeForScore(run.id)
      if (raced) return raced
      // Otherwise an id collision, which a retry settles.
      if (attempt >= 3) throw err
    }
  }
}

/* ---------- a friend's run against it ---------- */

export type ChallengeRun = {
  /** Beat it, fell short of it, or it was their own. */
  outcome: 'won' | 'short' | 'own'
  challengeId: string
  /** Whose challenge, and the score it set. */
  name: string
  score: number
  /** The challenge sent back to them from a winning run. */
  replyId: string | null
}

/**
 * Record a saved run against a challenge: keep the player's best go, send a
 * winning run back as a challenge of its own, and tell the challenger.
 * Returns null when there is no such challenge on this game.
 */
export async function recordChallengeRun(
  input: { challengeId: string; game: GameSlug; name: string; accountId: string; score: number; scoreId: string },
  now = Date.now(),
): Promise<ChallengeRun | null> {
  const challenge = await getChallenge(input.challengeId)
  if (!challenge || challenge.game !== input.game) return null
  const base = { challengeId: challenge.id, name: challenge.name, score: challenge.score }
  // Playing your own challenge is just playing.
  if (challenge.name === input.name || challenge.accountId === input.accountId) {
    return { ...base, outcome: 'own', replyId: null }
  }

  const won = input.score > challenge.score
  const [prior] = await db()
    .select()
    .from(challengeResults)
    .where(and(eq(challengeResults.challengeId, challenge.id), eq(challengeResults.name, input.name)))
    .limit(1)
  const improved = !prior || input.score > prior.score
  const firstWin = won && !prior?.won

  let replyId = prior?.replyId ?? null
  if (firstWin) {
    const reply = await createChallenge(
      { game: input.game, name: input.name, accountId: input.accountId, scoreId: input.scoreId, replyTo: challenge.id },
      now,
    ).catch(() => null)
    replyId = reply?.id ?? null
  }

  if (prior) {
    await db()
      .update(challengeResults)
      .set({
        attempts: prior.attempts + 1,
        updatedAt: now,
        replyId,
        ...(improved ? { score: input.score, won: won || prior.won } : {}),
      })
      .where(and(eq(challengeResults.challengeId, challenge.id), eq(challengeResults.name, input.name)))
  } else {
    await db().insert(challengeResults).values({
      challengeId: challenge.id,
      name: input.name,
      accountId: input.accountId,
      score: input.score,
      won,
      replyId,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    })
  }

  await tellChallenger(challenge, input, { won, firstWin, improved, replyId }, now).catch((err: unknown) => {
    console.warn(`[challenges] could not tell ${challenge.name} about ${challenge.id}:`, err)
  })

  return { ...base, outcome: won ? 'won' : 'short', replyId }
}

async function tellChallenger(
  challenge: ChallengeRow,
  run: { game: GameSlug; name: string; score: number },
  what: { won: boolean; firstWin: boolean; improved: boolean; replyId: string | null },
  now: number,
) {
  const game = run.game
  const set = scoreFigure(game, challenge.score)
  if (what.won) {
    // Once a win: a later, higher win is still the same news.
    if (!what.firstWin) return
    const title = `${run.name} beat your ${set} on ${gameLabel(game)}`
    const body = `with ${scoreFigure(game, run.score)}. Take it back?`
    const href = what.replyId ? `/c/${game}/${what.replyId}` : `/games/${game}/play`
    const key = `challenge-beaten:${challenge.id}:${run.name}`
    await notify({ accountId: challenge.accountId, kind: 'challenge-beaten', title, body, href, digestKey: key, now })
    await sendPush(challenge.accountId, { kind: 'challenge-beaten', title, body, href, dedupeKey: key }, now)
    return
  }
  // A try that fell short is worth a line, once for each time they get closer.
  if (!what.improved) return
  await notify({
    accountId: challenge.accountId,
    kind: 'challenge-taken',
    title: `${run.name} took your challenge on ${gameLabel(game)}`,
    body: `${scoreFigure(game, run.score)}, ${gapWords(game, challenge.score - run.score)} short of your ${set}.`,
    href: `/games/${game}`,
    digestKey: `challenge-taken:${challenge.id}:${run.name}`,
    now,
  })
}
