import { bestInMatch, bracketGamesForRound, matchAttempts } from './bracket.js'
import { dayKey, notify, type NotificationKind } from './notifications.js'
import { sendPush } from './push.js'
import type { Tournament } from './tournaments.js'

/**
 * The one thing in this arcade worth interrupting someone for.
 *
 * A bracket match has a clock and a forfeit behind it: miss the window and you
 * are out, and the rest of the draw stalls waiting on you. That is the whole
 * case for push — nothing else here expires.
 *
 * Both alerts are idempotent by key, so this can run on every read of the
 * tournament list without duplicating anything.
 */

/** How close to the deadline the nudge fires. */
const CLOSING_SOON_MS = 3 * 60 * 60 * 1000

export type MatchAlert = {
  accountId: string
  kind: Extract<NotificationKind, 'match-open' | 'match-closing'>
  title: string
  body: string
  href: string
  key: string
}

function hoursLeft(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000))
  return hours === 1 ? '1 hour' : `${hours} hours`
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
    if (match.winnerId) continue
    const [a, b] = match.playerIds
    if (!a || !b) continue
    if (match.playEndsAt == null) continue

    const remaining = match.playEndsAt - now
    if (remaining <= 0) continue
    const closing = remaining <= CLOSING_SOON_MS
    const games = bracketGamesForRound(t, match.round)

    for (const seatId of [a, b]) {
      const seat = seatById.get(seatId)
      if (!seat?.accountId) continue
      const opponentId = seatId === a ? b : a
      const opponent = seatById.get(opponentId)?.name ?? 'your opponent'

      const played = games.every((game) => matchAttempts(t, seatId, match.id, game) > 0)
      const spent = games.every(
        (game) => matchAttempts(t, seatId, match.id, game) >= maxAttempts,
      )

      /*
       * The test that matters is "do nothing and you lose", which covers two
       * shapes: never turned up, or turned up and is behind with a try left.
       * Only judged on a single-game round — across a series a later game can
       * still swing it, so "behind" is not yet a verdict.
       */
      let behindWithTriesLeft = false
      if (!spent && games.length === 1) {
        const mine = bestInMatch(t, seatId, match.id)?.score ?? 0
        const theirs = bestInMatch(t, opponentId, match.id)?.score ?? 0
        behindWithTriesLeft = mine < theirs
      }

      if (closing && (!played || behindWithTriesLeft)) {
        out.push({
          accountId: seat.accountId,
          kind: 'match-closing',
          title: `${hoursLeft(remaining)} left against ${opponent}`,
          body: played
            ? `You're behind in ${t.title} with a run left. Do nothing and you're out.`
            : `Your ${t.title} match closes soon. No score means you forfeit.`,
          href: `#/tournaments/${t.id}`,
          key: `match-closing:${t.id}:${match.id}`,
        })
        continue
      }

      if (!played) {
        out.push({
          accountId: seat.accountId,
          kind: 'match-open',
          title: `You're up against ${opponent}`,
          body: `Your ${t.title} match is open. ${hoursLeft(remaining)} to post a score.`,
          href: `#/tournaments/${t.id}`,
          key: `match-open:${t.id}:${match.id}`,
        })
      }
    }
  }

  return out
}

/**
 * Remembered across the process so a busy list does not re-run the same upserts
 * on every single read. The database keys are the real guard; this is just to
 * keep the chatter down.
 */
const filed = new Set<string>()

export async function fileMatchAlerts(tournaments: Tournament[], now: number) {
  const pending: Promise<unknown>[] = []

  for (const t of tournaments) {
    for (const alert of matchAlertsFor(t, now)) {
      const memo = `${alert.accountId}:${alert.key}`
      if (filed.has(memo)) continue
      filed.add(memo)

      pending.push(
        (async () => {
          await notify({
            accountId: alert.accountId,
            kind: alert.kind,
            title: alert.title,
            body: alert.body,
            href: alert.href,
            // One row per match transition, not one per sweep.
            digestKey: `${alert.key}:${dayKey(now)}`,
            now,
          })
          await sendPush(
            alert.accountId,
            {
              kind: alert.kind,
              title: alert.title,
              body: alert.body,
              href: alert.href,
              dedupeKey: alert.key,
            },
            now,
          )
        })().catch(() => undefined),
      )
    }
  }

  if (pending.length) await Promise.all(pending)
}

/** Test seam — the memo is process-local and would otherwise leak between runs. */
export function resetMatchAlertMemo() {
  filed.clear()
}
