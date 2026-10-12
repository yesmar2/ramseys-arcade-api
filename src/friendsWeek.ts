import { FRIENDS_SCOPE, resolveBoardScope } from './groups.js'
import { namesOwnedByAccount, withAvatarIds } from './names.js'
import { closedRanksAmong, weekStartKey, type GameSlug } from './store.js'

/*
 * Last week among a player's friends (Ramsey, 2026-10-11: "go with your picks", A · Takeover from the "More
 * celebrations" canvas). A win over people gets the whole screen, and few will ever top the whole arcade's
 * standings, but plenty can top their friends'. This is the standings of the week that closed among the
 * player's own tags and their friends' (store.ts closedRanksAmong): where their best tag finished and out of
 * how many, the top three, and their games. The site asks once a week (its FriendsWeekMoment) and shows
 * the takeover to whoever was first.
 */

export type FriendsWeek = {
  /** The week that closed: its Monday, YYYY-MM-DD. */
  week: string
  /** How many of you and your friends had points in it. */
  field: number
  /** Your best tag's line; null with no points that week. */
  you: { name: string; rank: number; points: number } | null
  /** The top three. */
  podium: { name: string; rank: number; points: number; avatarId: string }[]
  /** Your games that week among your friends, best place first. */
  games: { game: GameSlug; place: number; field: number }[]
}

/** A closed week doesn't move, but friends come and go: each account's is kept this long. */
const KEPT_MS = 15 * 60_000
const KEPT_MAX = 5_000
const kept = new Map<string, { at: number; value: Promise<FriendsWeek> }>()

/** The Monday of the week before this one, YYYYMMDD on the boards' clock. */
function lastWeekKey(now: number): number {
  const key = weekStartKey(now)
  const dt = new Date(Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100))
  dt.setUTCDate(dt.getUTCDate() - 7)
  return dt.getUTCFullYear() * 10_000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate()
}

function dayOf(key: number): string {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

async function workOut(accountId: string, periodKey: number): Promise<FriendsWeek> {
  const week = dayOf(periodKey)
  const own = new Set((await namesOwnedByAccount(accountId)).map((n) => n.name))
  const names = (await resolveBoardScope(FRIENDS_SCOPE, { accountId }))?.names ?? own
  // Nobody but you: no one to have finished ahead of.
  if (![...names].some((name) => !own.has(name))) return { week, field: 0, you: null, podium: [], games: [] }
  const ranks = await closedRanksAmong('weekly', periodKey, names)
  // In standings order: the first of yours is your best.
  const mine = ranks.find((row) => own.has(row.name)) ?? null
  const podium = await withAvatarIds(ranks.slice(0, 3).map((row) => ({ name: row.name, rank: row.rank, points: row.score })))
  const games = mine
    ? Object.entries(mine.byGame)
        .flatMap(([game, at]) => (at ? [{ game: game as GameSlug, place: at.place, field: at.total }] : []))
        .sort((a, b) => a.place - b.place || b.field - a.field)
    : []
  return {
    week,
    field: ranks.length,
    you: mine ? { name: mine.name, rank: mine.rank, points: mine.score } : null,
    podium,
    games,
  }
}

export function friendsWeek(accountId: string, now = Date.now()): Promise<FriendsWeek> {
  const id = `${accountId}:${lastWeekKey(now)}`
  const hit = kept.get(id)
  if (hit && now - hit.at < KEPT_MS) return hit.value
  const value = workOut(accountId, lastWeekKey(now))
  if (kept.size >= KEPT_MAX) kept.clear()
  kept.set(id, { at: now, value })
  value.catch(() => {
    if (kept.get(id)?.value === value) kept.delete(id)
  })
  return value
}
