import type { Request } from 'express'
import { and, count, eq, gte, lt } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, trophyAwards } from './db/schema.js'
import { notify } from './notifications.js'
import { ALLOWED_GAMES, boardDateKey, dayStartMs, type GameSlug } from './store.js'

/*
 * Secret trophies: odd things a player can do that nothing on the site mentions until they've done them.
 * Each is a trophy like any other (period 'secret', its periodKey the secret's number below), on the
 * shelf of the tag the account plays as, once an account. A saved run, a bug caught or a day's hole can
 * find one; the site's easter eggs find their own (POST /secrets/found, EGG_SECRETS). The site keeps the
 * same list, by number, with each one's art (lib/secrets.ts), and its admin page says every rule below in
 * words (components/AdminTrophies.tsx): change both with any rule here.
 *
 * Seven are retired, at Ramsey's word (2026-10-05): Palindrome, Lucky Sevens, Photo Finish and So Close
 * ("I don't like these secret trophies ... can you remove them?"), then Make a Wish, Déjà Vu and Round Number
 * ("remove these ones too"). Their numbers stay unused, so every other secret keeps the number its finds
 * are kept under, and a find of a retired one is kept but shown nowhere (trophies.ts trophiesForName).
 */

export const SECRETS = {
  nightowl: { n: 1, name: 'Night Owl', says: 'Played a run between 3 and 4 in the morning.' },
  earlybird: { n: 2, name: 'Early Bird', says: 'Caught the day’s bug before 8 in the morning.' },
  grandtour: { n: 3, name: 'Grand Tour', says: 'Played every game in the arcade in one day.' },
  holeinone: { n: 8, name: 'Hole in One', says: 'Today’s Hole on the very first try.' },
  konami: { n: 9, name: 'Up Up Down Down', says: 'Found the old cheat code.' },
  blip: { n: 10, name: 'Blip Blip', says: 'Tapped the blip until it tapped back.' },
  marathon: { n: 14, name: 'Marathon', says: 'Fifty runs in one day.' },
  barrelroll: { n: 15, name: 'Barrel Roll', says: 'Asked the search for a barrel roll.' },
  corner: { n: 16, name: 'Perfect Corner', says: 'Watched the bouncing blip hit the corner.' },
  cheats: { n: 17, name: 'Nice Try', says: 'Tried an old cheat on the arcade.' },
  continue: { n: 18, name: 'Continue?', says: 'Put a coin in at Game Over.' },
  shatter: { n: 19, name: 'Smashing', says: 'Broke a balanced plate in Centroid.' },
  placebo: { n: 20, name: 'Placebo', says: 'Pressed the button at a crossing. Nothing happened.' },
  jackpot: { n: 21, name: 'Jackpot', says: 'Pulled Bop’s lever all the way down to the cherries.' },
  donuts: { n: 22, name: 'Donuts', says: 'Spun three donuts on Hot Lap’s track.' },
  marbles: { n: 23, name: 'Lost Your Marbles', says: 'Fell off Marble Run three times before the first checkpoint.' },
  wargames: { n: 24, name: 'Shall We Play a Game?', says: 'Let a whole wave of Patriot fall without firing a shot.' },
  safespot: { n: 25, name: 'Safe Spot', says: 'Hid from the chasers in Pellets’ safe spot.' },
  alien: { n: 26, name: 'Little Green Friend', says: 'Got a wave from the alien in Lander’s cave.' },
  shootingstar: { n: 27, name: 'Shooting Star', says: 'Caught a shooting star over the Fireflies pond.' },
  moon: { n: 28, name: 'Shoot the Moon', says: 'Shot the moon over Barrage until it had a black eye.' },
} as const

export type SecretKey = keyof typeof SECRETS
export type SecretFound = { key: SecretKey; n: number; name: string; says: string }

/** The secrets there are, by number: a find of any other is a retired secret's. */
export const SECRET_NUMBERS: ReadonlySet<number> = new Set(Object.values(SECRETS).map((s) => s.n))

/** The secrets the site's easter eggs find, which it reports itself. */
export const EGG_SECRETS: readonly SecretKey[] = [
  'konami',
  'blip',
  'barrelroll',
  'corner',
  'cheats',
  'continue',
  'shatter',
  'placebo',
  'jackpot',
  'donuts',
  'marbles',
  'wargames',
  'safespot',
  'alien',
  'shootingstar',
  'moon',
]

/** Saved runs in one of the boards' days that make a Marathon. */
const MARATHON_RUNS = 50

/** Every game the site lists (data/games.ts hides Simon and Spotter): the Grand Tour's. */
const TOUR_GAMES: readonly GameSlug[] = ALLOWED_GAMES.filter((g) => g !== 'simon' && g !== 'spotter')

/**
 * The player's own clock, as the site sends it with what it posts (X-TZ-Offset: Date#getTimezoneOffset,
 * minutes behind UTC), or null. Only the time-of-day secrets (Night Owl, Early Bird) use it, so its word is
 * enough.
 */
export function clientOffset(req: Request): number | null {
  const raw = req.get('x-tz-offset')
  if (raw == null || raw.trim() === '') return null
  const minutes = Number(raw)
  return Number.isFinite(minutes) && Math.abs(minutes) <= 14 * 60 ? Math.round(minutes) : null
}

/** The hour on the player's clock at `at`. */
function localHour(at: number, offset: number): number {
  return new Date(at - offset * 60_000).getUTCHours()
}

/** The secrets an account has found, by number: its shelf's, and what the site's eggs check (GET /secrets/found). */
export async function foundBefore(accountId: string): Promise<Set<number>> {
  const rows = await db()
    .select({ n: trophyAwards.periodKey })
    .from(trophyAwards)
    .where(and(eq(trophyAwards.period, 'secret'), eq(trophyAwards.accountId, accountId)))
  return new Set(rows.map((r) => r.n))
}

/**
 * A secret found: on the shelf of the tag the account plays as, and in its inbox. Once an account; null
 * if it was found before.
 */
export async function awardSecret(opts: {
  accountId: string
  name: string
  key: SecretKey
  score?: number
  games?: number
  at: number
}): Promise<SecretFound | null> {
  const secret = SECRETS[opts.key]
  const name = opts.name.trim().slice(0, 12).toUpperCase()
  if (!name) return null
  if ((await foundBefore(opts.accountId)).has(secret.n)) return null
  const inserted = await db()
    .insert(trophyAwards)
    .values({
      id: `secret-${secret.n}-${name}`,
      period: 'secret',
      periodKey: secret.n,
      name,
      rank: 1,
      score: Math.max(0, Math.floor(opts.score ?? 0)),
      games: Math.max(0, Math.floor(opts.games ?? 0)),
      accountId: opts.accountId,
      awardedAt: opts.at,
    })
    .onConflictDoNothing()
    .returning({ id: trophyAwards.id })
  if (!inserted.length) return null
  await notify({
    accountId: opts.accountId,
    kind: 'trophy',
    title: `You found a secret: ${secret.name}`,
    body: `${secret.says} It’s on your shelf now.`,
    href: '/rank/all?focus=trophies',
    meta: { trophy: { period: 'secret', rank: 1, n: secret.n } },
    digestKey: `trophy:secret:${secret.n}`,
    once: true,
    now: opts.at,
  }).catch(() => undefined)
  return { key: opts.key, n: secret.n, name: secret.name, says: secret.says }
}

/**
 * This tag's play on the boards' day of `at`: whether every listed game has a run (Grand Tour), and how
 * many runs there are in all (Marathon). A solved Today's Hole is on the board too, so it counts.
 */
async function dayOfPlay(name: string, at: number): Promise<{ everyGame: boolean; runs: number }> {
  const start = dayStartMs(boardDateKey(at))
  // Thirty hours on is always the next day, however long a day is when the clocks change.
  const end = dayStartMs(boardDateKey(start + 30 * 3_600_000))
  const rows = await db()
    .select({ game: leaderboardScores.game, runs: count() })
    .from(leaderboardScores)
    .where(and(eq(leaderboardScores.name, name), gte(leaderboardScores.at, start), lt(leaderboardScores.at, end)))
    .groupBy(leaderboardScores.game)
  const played = new Set(rows.map((r) => r.game))
  return { everyGame: TOUR_GAMES.every((g) => played.has(g)), runs: rows.reduce((sum, r) => sum + Number(r.runs), 0) }
}

/** Grand Tour and Marathon, whichever the account hasn't got, from one look at the day. */
async function dayFinds(
  had: ReadonlySet<number>,
  name: string,
  at: number,
  award: (key: SecretKey, extra?: { games?: number }) => Promise<void>,
) {
  const tour = !had.has(SECRETS.grandtour.n)
  const marathon = !had.has(SECRETS.marathon.n)
  if (!tour && !marathon) return
  const day = await dayOfPlay(name, at)
  if (tour && day.everyGame) await award('grandtour', { games: TOUR_GAMES.length })
  if (marathon && day.runs >= MARATHON_RUNS) await award('marathon', { games: day.runs })
}

/**
 * The secrets a saved run finds, after it's on the board: Night Owl by the player's clock (`offset`), and
 * Grand Tour or Marathon by the day's play.
 */
export async function secretsForRun(opts: { accountId: string; name: string; offset: number | null; at: number }): Promise<SecretFound[]> {
  const had = await foundBefore(opts.accountId)
  const found: SecretFound[] = []
  const award = async (key: SecretKey, extra: { games?: number } = {}) => {
    if (had.has(SECRETS[key].n)) return
    const secret = await awardSecret({ accountId: opts.accountId, name: opts.name, key, at: opts.at, ...extra })
    if (secret) found.push(secret)
  }
  if (opts.offset != null && localHour(opts.at, opts.offset) === 3) await award('nightowl')
  await dayFinds(had, opts.name, opts.at, award)
  return found
}

/**
 * The secrets a day's hole finds, once its result is on Ace Chase's board: Hole in One, and Grand Tour or
 * Marathon if the hole was the day's last game or fiftieth run (a run's own check doesn't see the hole's
 * result).
 */
export async function secretsForHole(opts: { accountId: string; name: string; tries: number; at: number }): Promise<SecretFound[]> {
  const had = await foundBefore(opts.accountId)
  const found: SecretFound[] = []
  const award = async (key: SecretKey, extra: { games?: number } = {}) => {
    if (had.has(SECRETS[key].n)) return
    const secret = await awardSecret({ accountId: opts.accountId, name: opts.name, key, at: opts.at, ...extra })
    if (secret) found.push(secret)
  }
  if (opts.tries === 1) await award('holeinone')
  await dayFinds(had, opts.name, opts.at, award)
  return found
}

/** The secrets a bug caught finds: Early Bird, for today's bug before 8 on the player's clock. */
export async function secretsForCatch(opts: { accountId: string; name: string; offset: number | null; at: number }): Promise<SecretFound[]> {
  if (opts.offset == null || localHour(opts.at, opts.offset) >= 8) return []
  const secret = await awardSecret({ accountId: opts.accountId, name: opts.name, key: 'earlybird', at: opts.at })
  return secret ? [secret] : []
}
