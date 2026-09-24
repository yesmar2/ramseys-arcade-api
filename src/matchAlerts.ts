import { and, inArray, isNull } from 'drizzle-orm'
import {
  bestInMatch,
  bracketGamesForRound,
  matchAttempts,
  matchSide,
  resolveElimination,
  type BracketMatch,
} from './bracket.js'
import { db } from './db/client.js'
import { notifications } from './db/schema.js'
import { MATCH_KINDS, type NotificationKind, type NotificationMeta } from './notifications.js'
import { fileAndPush } from './push.js'
import type { GameSlug } from './store.js'
import type { Tournament } from './tournaments.js'
import { andList, gameLabel, scoreFigure, timeLeft } from './words.js'

/**
 * The one thing in this arcade worth interrupting someone for.
 *
 * A bracket match has a clock and a forfeit behind it: miss the window and you
 * are out, and the rest of the draw stalls waiting on you. That is the whole
 * case for push — nothing else here expires.
 *
 * Each match gets one alert per seat at a time: "you're up" when it opens,
 * swapped for "hours left" if the player is still missing when it's nearly
 * over, and taken away once they've played or the match is settled. The
 * sweep files them, so they don't wait for somebody to open a page.
 */

/** How close to the deadline the nudge fires. */
const CLOSING_SOON_MS = 3 * 60 * 60 * 1000

export type MatchAlert = {
  accountId: string
  kind: Extract<NotificationKind, 'match-open' | 'match-closing'>
  title: string
  body: string
  href: string
  meta: NotificationMeta
  key: string
}

/** Where a match sits in its draw, the way a player would say it. */
function stageWords(t: Tournament, match: BracketMatch): string {
  const side = matchSide(match)
  if (side === 'gf') return 'the grand final'
  if (side === 'lb') return `round ${match.round} of the losers’ bracket`
  const lastRound = Math.max(
    ...(t.bracket?.matches ?? []).filter((m) => matchSide(m) === 'wb' && !m.void).map((m) => m.round),
  )
  if (match.round === lastRound) return resolveElimination(t) === 'double' ? 'the winners’ final' : 'the final'
  if (lastRound >= 3 && match.round === lastRound - 1) return 'the semi-finals'
  return `round ${match.round}`
}

/**
 * Work out which alerts this tournament currently warrants.
 *
 * Pure, so the rules can be tested without a database behind them.
 */
export function matchAlertsFor(t: Tournament, now: number): MatchAlert[] {
  if (!t.bracket?.lockedAt) return []
  const seatById = new Map(t.players.map((p) => [p.id, p]))
  // Read straight off the rules rather than importing from tournaments.ts,
  // which imports this module — the tournaments handed in are normalized.
  const maxAttempts = Math.max(1, Math.min(99, t.rules?.maxAttempts ?? 1))
  const out: MatchAlert[] = []

  for (const match of t.bracket.matches) {
    if (match.winnerId || match.void) continue
    const [a, b] = match.playerIds
    if (!a || !b) continue
    if (match.playEndsAt == null) continue

    const remaining = match.playEndsAt - now
    if (remaining <= 0) continue
    const closing = remaining <= CLOSING_SOON_MS
    const games = bracketGamesForRound(t, match.round)
    const where = `${t.title}, ${stageWords(t, match)} on ${andList(games.map(gameLabel))}.`

    for (const seatId of [a, b]) {
      const seat = seatById.get(seatId)
      if (!seat?.accountId) continue
      const opponentId = seatId === a ? b : a
      const opponent = seatById.get(opponentId)?.name ?? null
      const against = opponent ?? 'your opponent'

      const played = games.every((game) => matchAttempts(t, seatId, match.id, game) > 0)
      const spent = games.every(
        (game) => matchAttempts(t, seatId, match.id, game) >= maxAttempts,
      )
      const unplayed = games.find((game) => matchAttempts(t, seatId, match.id, game) === 0) ?? games[0]

      /*
       * The test that matters is "do nothing and you lose", which covers two
       * shapes: never turned up, or turned up and is behind with a try left.
       * Only judged on a single-game round — across a series a later game can
       * still swing it, so "behind" is not yet a verdict.
       */
      let behind: { mine: number; theirs: number } | null = null
      if (!spent && games.length === 1) {
        const mine = bestInMatch(t, seatId, match.id)?.score ?? 0
        const theirs = bestInMatch(t, opponentId, match.id)?.score ?? 0
        if (mine < theirs) behind = { mine, theirs }
      }

      const meta: NotificationMeta = {
        ...(opponent ? { actor: opponent } : {}),
        ...(games[0] ? { game: games[0] } : {}),
        eventId: t.id,
        matchId: match.id,
        endsAt: match.playEndsAt,
        ...(unplayed ? { playHref: `/tournaments/${t.id}/play/${unplayed}` } : {}),
      }
      const href = `/tournaments/${t.id}`

      if (closing && (!played || behind)) {
        const game = games[0] as GameSlug
        out.push({
          accountId: seat.accountId,
          kind: 'match-closing',
          title: `${timeLeft(remaining)} left against ${against}`,
          body:
            played && behind
              ? `${where} You’re behind, ${scoreFigure(game, behind.mine)} to ${scoreFigure(game, behind.theirs)}, with a run left.`
              : `${where} No score yet, and no score means you’re out.`,
          href,
          meta: played && behind ? { ...meta, playHref: `/tournaments/${t.id}/play/${game}` } : meta,
          key: `match-closing:${t.id}:${match.id}`,
        })
        continue
      }

      if (!played) {
        out.push({
          accountId: seat.accountId,
          kind: 'match-open',
          title: `You’re up against ${against}`,
          body: `${where} ${timeLeft(remaining)} to post a score.`,
          href,
          meta,
          key: `match-open:${t.id}:${match.id}`,
        })
      }
    }
  }

  return out
}

const MATCH_KEY = /^match-(?:open|closing):([^:]+):([^:]+)(:\d{8})?$/

/**
 * Take back alerts for matches that no longer need the player: played,
 * settled, or out of time. An alert filed under the old per-day key is
 * replaced by the one filed under the match alone.
 */
async function clearFinishedAlerts(eventIds: Set<string>, live: Set<string>) {
  const rows = await db()
    .select({ id: notifications.id, accountId: notifications.accountId, digestKey: notifications.digestKey })
    .from(notifications)
    .where(and(inArray(notifications.kind, [...MATCH_KINDS]), isNull(notifications.resolvedAt)))
  const gone: string[] = []
  for (const row of rows) {
    const m = row.digestKey ? MATCH_KEY.exec(row.digestKey) : null
    if (!m || !eventIds.has(m[1]!)) continue
    if (m[3] || !live.has(`${row.accountId}|${row.digestKey}`)) gone.push(row.id)
  }
  if (gone.length) await db().delete(notifications).where(inArray(notifications.id, gone))
}

/** File the alerts these tournaments warrant now, and clear the ones they no longer do. */
export async function fileMatchAlerts(tournaments: Tournament[], now: number) {
  const alerts = tournaments.flatMap((t) => matchAlertsFor(t, now))
  const live = new Set(alerts.map((a) => `${a.accountId}|${a.key}`))

  for (const alert of alerts) {
    await fileAndPush({
      accountId: alert.accountId,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      href: alert.href,
      meta: alert.meta,
      digestKey: alert.key,
      // Filed once per match: the sweep finds it still true every few minutes.
      once: true,
      now,
    }).catch((err: unknown) => {
      console.warn(`[alerts] ${alert.key} for ${alert.accountId} failed:`, err)
    })
  }

  await clearFinishedAlerts(new Set(tournaments.map((t) => t.id)), live).catch((err: unknown) => {
    console.warn('[alerts] clearing finished match alerts failed:', err)
  })
}
