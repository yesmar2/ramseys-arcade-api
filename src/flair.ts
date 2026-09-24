import { eq } from 'drizzle-orm'
import { AVATAR_GAME_PINS, AVATAR_PINS, AVATAR_RINGS, type AvatarPin, type AvatarRing } from './avatars.js'
import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'
import { listGameRecords } from './records.js'
import { boardDateKey, previousBoardDateKey, rankForName, type GameSlug } from './store.js'
import { trophiesForName } from './trophies.js'

/*
 * Flair: the rings and pins an avatar can wear, and whether a player has
 * earned each. Nothing here can be bought; every one is something the player
 * did on the boards.
 *
 *   Rings, for how you've placed: bronze for a week in the arcade's top three,
 *   silver for a week in its top two, gold for winning a week, the record ring
 *   for holding a record in a record book, the laurel for winning an event.
 *   Pins, for what you've done: welcome (everyone), five different games, a
 *   seven-day streak, the crown for winning a month, and one per game for its
 *   all-time top ten.
 *
 * Trophies are kept for good, so what they give is kept too. A record or a
 * place in a top ten can be lost; an avatar already wearing one keeps it (see
 * mayWear), so losing the place never strips it, but it can't be put back on.
 */

export type FlairState = {
  id: string
  earned: boolean
  /** How far along, for the app to put in words: a best place, a count, a number of days. */
  best: number | null
  /** For the record ring: the player's best standing in any record book. */
  record?: { game: GameSlug; label: string; rank: number } | null
}

export type Flair = { name: string; rings: FlairState[]; pins: FlairState[] }

const GAMES_FOR_PIN = 5
const STREAK_FOR_PIN = 7
const TOP_FOR_PIN = 10
const CACHE_MS = 60_000

const cache = new Map<string, { at: number; flair: Flair }>()

function bestStreak(dayKeys: number[]): number {
  const days = [...new Set(dayKeys)].sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const day of days) {
    run = prev != null && previousBoardDateKey(day) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return best
}

async function recordStanding(name: string): Promise<{ held: boolean; best: FlairState['record'] }> {
  let held = false
  let best: FlairState['record'] = null
  for (const game of AVATAR_GAME_PINS) {
    const { records } = await listGameRecords(game, 'all', Date.now(), undefined, name)
    for (const r of records) {
      if (r.top?.name === name) held = true
      const rank = r.you?.rank
      if (rank != null && (!best || rank < best.rank)) best = { game, label: r.label, rank }
    }
  }
  return { held, best }
}

export async function flairFor(rawName: string, now = Date.now()): Promise<Flair> {
  const name = rawName.trim().slice(0, 12).toUpperCase()
  const hit = cache.get(name)
  if (hit && now - hit.at < CACHE_MS) return hit.flair

  const [trophies, standing, runs, records] = await Promise.all([
    trophiesForName(name),
    rankForName(name, 0, 'all', now),
    db()
      .select({ game: leaderboardScores.game, at: leaderboardScores.at })
      .from(leaderboardScores)
      .where(eq(leaderboardScores.name, name)),
    recordStanding(name),
  ])

  const weekly = trophies.filter((t) => t.period === 'weekly').map((t) => t.rank)
  const monthly = trophies.filter((t) => t.period === 'monthly').map((t) => t.rank)
  const bestWeek = weekly.length ? Math.min(...weekly) : null
  const bestMonth = monthly.length ? Math.min(...monthly) : null
  const events = trophies.filter((t) => t.period === 'event').length
  const sets = trophies.filter((t) => t.period === 'hunt').length
  const games = new Set(runs.map((r) => r.game)).size
  const streak = bestStreak(runs.map((r) => boardDateKey(r.at)))

  const ring = (id: AvatarRing): FlairState => {
    switch (id) {
      case 'bronze':
        return { id, earned: bestWeek != null && bestWeek <= 3, best: bestWeek }
      case 'silver':
        return { id, earned: bestWeek != null && bestWeek <= 2, best: bestWeek }
      case 'gold':
        return { id, earned: bestWeek === 1, best: bestWeek }
      case 'record':
        return { id, earned: records.held, best: records.best?.rank ?? null, record: records.best }
      case 'laurel':
        return { id, earned: events > 0, best: events }
    }
  }
  const pin = (id: AvatarPin): FlairState => {
    switch (id) {
      case 'welcome':
        return { id, earned: true, best: null }
      case 'games':
        return { id, earned: games >= GAMES_FOR_PIN, best: games }
      case 'streak':
        return { id, earned: streak >= STREAK_FOR_PIN, best: streak }
      case 'crown':
        return { id, earned: bestMonth === 1, best: bestMonth }
      case 'bugnet':
        return { id, earned: sets > 0, best: sets }
      default: {
        const place = standing.byGame[id as GameSlug]?.place ?? null
        return { id, earned: place != null && place <= TOP_FOR_PIN, best: place }
      }
    }
  }

  const flair: Flair = { name, rings: AVATAR_RINGS.map(ring), pins: AVATAR_PINS.map(pin) }
  cache.set(name, { at: now, flair })
  return flair
}

/**
 * Whether a player may save an avatar wearing this ring and pin: each has to
 * be earned, or already be on the avatar they have now, so a place that has
 * since slipped away doesn't take a ring off.
 */
export async function mayWear(
  name: string,
  wanted: { ring: AvatarRing | null; pin: AvatarPin | null },
  current: { ring: AvatarRing | null; pin: AvatarPin | null } | null,
): Promise<boolean> {
  if (!wanted.ring && !wanted.pin) return true
  const flair = await flairFor(name)
  const ringOk = !wanted.ring || wanted.ring === current?.ring || flair.rings.some((r) => r.id === wanted.ring && r.earned)
  const pinOk = !wanted.pin || wanted.pin === current?.pin || flair.pins.some((p) => p.id === wanted.pin && p.earned)
  return ringOk && pinOk
}

export function invalidateFlair(name?: string) {
  if (name) cache.delete(name.trim().slice(0, 12).toUpperCase())
  else cache.clear()
}
