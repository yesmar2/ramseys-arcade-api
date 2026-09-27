import type { Request } from 'express'
import { and, eq, gte, lt } from 'drizzle-orm'
import { db } from './db/client.js'
import { leaderboardScores, trophyAwards } from './db/schema.js'
import { notify } from './notifications.js'
import { ALLOWED_GAMES, boardDateKey, dayStartMs, getBoard, type GameSlug } from './store.js'

/*
 * Secret trophies: odd things a player can do that nothing on the site mentions until they've done them.
 * Each is a trophy like any other (period 'secret', its periodKey the secret's number below), on the
 * shelf of the tag the account plays as, once an account. A saved run, a bug caught or a day's hole can
 * find one; the site's easter eggs find their own (POST /secrets/found). The site keeps the same list,
 * by number, with each one's art (lib/secrets.ts).
 */

export const SECRETS = {
  nightowl: { n: 1, name: 'Night Owl', says: 'Played a run between 3 and 4 in the morning.' },
  earlybird: { n: 2, name: 'Early Bird', says: 'Caught the day’s bug before 8 in the morning.' },
  grandtour: { n: 3, name: 'Grand Tour', says: 'Played every game in the arcade in one day.' },
  palindrome: { n: 4, name: 'Palindrome', says: 'A score of four figures or more that reads the same backwards.' },
  sevens: { n: 5, name: 'Lucky Sevens', says: 'A score of nothing but sevens.' },
  photofinish: { n: 6, name: 'Photo Finish', says: 'Tied for first on a game’s board this week.' },
  soclose: { n: 7, name: 'So Close', says: 'One point short of a game’s record.' },
  holeinone: { n: 8, name: 'Hole in One', says: 'Today’s Hole on the very first try.' },
  konami: { n: 9, name: 'Up Up Down Down', says: 'Found the old cheat code.' },
  blip: { n: 10, name: 'Blip Blip', says: 'Tapped the blip until it tapped back.' },
} as const

export type SecretKey = keyof typeof SECRETS
export type SecretFound = { key: SecretKey; n: number; name: string; says: string }

/** The secrets the site's easter eggs find, which it reports itself. */
export const EGG_SECRETS: readonly SecretKey[] = ['konami', 'blip']

/** Games shown as a number of points, where a score's digits mean something to the player. */
const POINTS_GAMES: ReadonlySet<GameSlug> = new Set(
  ALLOWED_GAMES.filter((g) => g !== 'acechase' && g !== 'spotter' && g !== 'findbug' && g !== 'hotlap'),
)

/** Every game the site lists (data/games.ts hides Simon and Spotter): the Grand Tour's. */
const TOUR_GAMES: readonly GameSlug[] = ALLOWED_GAMES.filter((g) => g !== 'simon' && g !== 'spotter')

/**
 * The player's own clock, as the site sends it on every request (X-TZ-Offset: Date#getTimezoneOffset,
 * minutes behind UTC), or null. Only the time-of-day secrets use it, so its word is enough.
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

async function foundBefore(accountId: string): Promise<Set<number>> {
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

function isPalindrome(n: number): boolean {
  const s = String(n)
  return s === [...s].reverse().join('')
}

/** Every listed game has a run from this tag on the boards' day of `at`. */
async function everyGameToday(name: string, at: number): Promise<boolean> {
  const start = dayStartMs(boardDateKey(at))
  // Thirty hours on is always the next day, however long a day is when the clocks change.
  const end = dayStartMs(boardDateKey(start + 30 * 3_600_000))
  const rows = await db()
    .selectDistinct({ game: leaderboardScores.game })
    .from(leaderboardScores)
    .where(and(eq(leaderboardScores.name, name), gte(leaderboardScores.at, start), lt(leaderboardScores.at, end)))
  const played = new Set(rows.map((r) => r.game))
  return TOUR_GAMES.every((g) => played.has(g))
}

/**
 * The secrets a saved run finds, after it's on the board. `record` is the game's best before this run,
 * for So Close; `offset` the player's clock, for Night Owl.
 */
export async function secretsForRun(opts: {
  accountId: string
  name: string
  game: GameSlug
  score: number
  record: number
  offset: number | null
  at: number
}): Promise<SecretFound[]> {
  const had = await foundBefore(opts.accountId)
  const found: SecretFound[] = []
  const award = async (key: SecretKey, extra: { score?: number; games?: number } = {}) => {
    if (had.has(SECRETS[key].n)) return
    const secret = await awardSecret({ accountId: opts.accountId, name: opts.name, key, at: opts.at, ...extra })
    if (secret) found.push(secret)
  }
  const { game, score } = opts
  if (opts.offset != null && localHour(opts.at, opts.offset) === 3) await award('nightowl')
  if (POINTS_GAMES.has(game)) {
    if (score >= 1000 && isPalindrome(score)) await award('palindrome', { score })
    if (score >= 777 && /^7+$/.test(String(score))) await award('sevens', { score })
    if (opts.record > 1 && score === opts.record - 1) await award('soclose', { score })
  }
  if (score > 0 && !had.has(SECRETS.photofinish.n)) {
    // Tied for first this week: the week's best is this score, and someone else has it too.
    const week = await getBoard(game, 'weekly', opts.at)
    if (week[0]?.score === score && week.some((e) => e.score === score && e.name !== opts.name)) await award('photofinish', { score })
  }
  if (!had.has(SECRETS.grandtour.n) && (await everyGameToday(opts.name, opts.at))) {
    await award('grandtour', { games: TOUR_GAMES.length })
  }
  return found
}

/** The secrets a bug caught finds: Early Bird, for today's bug before 8 on the player's clock. */
export async function secretsForCatch(opts: { accountId: string; name: string; offset: number | null; at: number }): Promise<SecretFound[]> {
  if (opts.offset == null || localHour(opts.at, opts.offset) >= 8) return []
  const secret = await awardSecret({ accountId: opts.accountId, name: opts.name, key: 'earlybird', at: opts.at })
  return secret ? [secret] : []
}
