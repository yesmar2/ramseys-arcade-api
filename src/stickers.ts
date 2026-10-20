import { and, eq, sql } from 'drizzle-orm'
import { Router } from 'express'
import { accountFromRequest } from './auth.js'
import { medalCountsOf, type MedalCounts } from './courseBests.js'
import { db } from './db/client.js'
import { seasonProgress, ticketLedger } from './db/schema.js'
import { cleanPlayerName, getClaim } from './names.js'
import { SEASONS, seasonNow } from './seasons.js'
import { boardDateKey, dayStartMs } from './store.js'
import { awardTickets } from './tickets.js'
import { keptDaysFor, bestTodayStreak } from './today.js'
import { trophiesForName, type TrophyAward } from './trophies.js'

/*
 * The sticker album on the back of the player card (Ramsey picked B3 of the "New prize kinds" canvas,
 * 2026-10-20: "Build B3, the album page on the back"). A page of twelve numbered stickers for the arcade, open
 * for good, and one for each season, which fills only while that season runs. Every sticker is for doing
 * something: nothing here is bought, and nothing reads a sticker but the card. The site has the stickers' names,
 * how to get each and their pictures (its data/stickers.ts, kept in step with the ids here); this says which a
 * player has. A full page pays its tickets once, to its owner, as they look at their own card.
 *
 *   GET /stickers?name=TAG   the player's pages: [{ id, got: [sticker ids], full }]
 */

/** What a full page pays, once. */
export const STICKER_PAGE_TICKETS = 250

/** What a player has done, as the rules read it. Gathered once a look. */
type Facts = {
  firstGoes: number
  bestStreak: number
  medals: MedalCounts
  trophies: TrophyAward[]
  /** The season's own, for its page; none before it opens. */
  season: { level: number; medals: MedalCounts; keptDays: number; trophies: TrophyAward[] } | null
}

type Sticker = { id: string; has: (f: Facts) => boolean }
type Page = { id: string; season?: number; stickers: readonly Sticker[] }

const golds = (m: MedalCounts) => m.gold + m.platinum
const medalsOf = (m: MedalCounts) => m.bronze + m.silver + m.gold + m.platinum
const weeklyTop = (t: TrophyAward[], rank: number) => t.some((a) => a.period === 'weekly' && a.rank <= rank)
const level = (f: Facts, n: number) => (f.season?.level ?? 0) >= n

/** The pages, in the order the card turns them. Ids are the site's; never reuse one. */
export const STICKER_PAGES: readonly Page[] = [
  {
    id: 's1',
    season: 1,
    stickers: [
      { id: 's1-liftoff', has: (f) => level(f, 1) },
      { id: 's1-moon', has: (f) => level(f, 5) },
      { id: 's1-ringed', has: (f) => level(f, 10) },
      { id: 's1-comet', has: (f) => level(f, 15) },
      { id: 's1-satellite', has: (f) => level(f, 20) },
      { id: 's1-astronaut', has: (f) => level(f, 25) },
      { id: 's1-supernova', has: (f) => level(f, 30) },
      { id: 's1-medals', has: (f) => medalsOf(f.season?.medals ?? NO_MEDALS) >= 5 },
      { id: 's1-gold', has: (f) => golds(f.season?.medals ?? NO_MEDALS) >= 5 },
      { id: 's1-dailies', has: (f) => (f.season?.keptDays ?? 0) >= 21 },
      { id: 's1-topten', has: (f) => weeklyTop(f.season?.trophies ?? [], 10) },
      { id: 's1-legend', has: (f) => (f.season?.trophies ?? []).some((a) => a.period === 'season' && a.rank <= 10) },
    ],
  },
  {
    id: 'arcade',
    stickers: [
      { id: 'a-first', has: (f) => f.firstGoes >= 1 },
      { id: 'a-explorer', has: (f) => f.firstGoes >= 10 },
      { id: 'a-week', has: (f) => f.bestStreak >= 7 },
      { id: 'a-fire', has: (f) => f.bestStreak >= 30 },
      { id: 'a-medal', has: (f) => medalsOf(f.medals) >= 1 },
      { id: 'a-goldrush', has: (f) => golds(f.medals) >= 10 },
      { id: 'a-platinum', has: (f) => f.medals.platinum >= 1 },
      { id: 'a-topten', has: (f) => weeklyTop(f.trophies, 10) },
      { id: 'a-podium', has: (f) => f.trophies.some((a) => (a.period === 'weekly' || a.period === 'monthly') && a.rank <= 3) },
      { id: 'a-champ', has: (f) => f.trophies.some((a) => a.period === 'monthly' && a.rank === 1) },
      { id: 'a-bug', has: (f) => f.trophies.some((a) => a.period === 'hunt') },
      { id: 'a-secret', has: (f) => f.trophies.some((a) => a.period === 'secret') },
    ],
  },
]

const NO_MEDALS: MedalCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0 }

/** A season's days, from its first (or its preview's) to its end; none before it opens. */
async function seasonWindow(id: number, now: number): Promise<[number, number] | null> {
  const def = SEASONS.find((s) => s.id === id)
  if (!def) return null
  const live = await seasonNow(now)
  if (live && live.def.id === id) return live.status === 'upcoming' ? null : [live.startsAt, live.endsAt]
  const start = dayStartMs(def.firstDay)
  return now >= start ? [start, dayStartMs(def.lastDay) + 86_400_000] : null
}

async function gatherFacts(accountId: string, name: string, now: number): Promise<Facts> {
  const [firsts, bestStreak, medals, trophies] = await Promise.all([
    db()
      .select({ n: sql<number>`count(distinct ${ticketLedger.ref})::int` })
      .from(ticketLedger)
      .where(and(eq(ticketLedger.accountId, accountId), eq(ticketLedger.reason, 'first'))),
    bestTodayStreak(accountId, now),
    medalCountsOf(accountId),
    trophiesForName(name),
  ])
  // The live season's page, or the last one's once it's over.
  const seasonId = STICKER_PAGES.find((p) => p.season != null)?.season ?? null
  let season: Facts['season'] = null
  const window = seasonId != null ? await seasonWindow(seasonId, now) : null
  if (seasonId != null && window) {
    const [progress] = await db()
      .select({ level: seasonProgress.level })
      .from(seasonProgress)
      .where(and(eq(seasonProgress.accountId, accountId), eq(seasonProgress.season, seasonId)))
    const [from, to] = [boardDateKey(window[0]), boardDateKey(window[1] - 1)]
    const kept = [...(await keptDaysFor(accountId, now))].filter((key) => key >= from && key <= to).length
    season = {
      level: progress?.level ?? 0,
      medals: await medalCountsOf(accountId, window),
      keptDays: kept,
      trophies: trophies.filter((t) => t.awardedAt >= window[0] && t.awardedAt < window[1] + 7 * 86_400_000),
    }
  }
  return { firstGoes: firsts[0]?.n ?? 0, bestStreak, medals, trophies, season }
}

export type StickerPageView = { id: string; got: string[]; full: boolean }

/** A player's pages: which stickers they have on each, and whether it's full. */
export async function stickerPages(accountId: string, name: string, now = Date.now()): Promise<StickerPageView[]> {
  const facts = await gatherFacts(accountId, name, now)
  return STICKER_PAGES.map((page) => {
    const got = page.stickers.filter((s) => s.has(facts)).map((s) => s.id)
    return { id: page.id, got, full: got.length === page.stickers.length }
  })
}

export const stickersRouter = Router()

stickersRouter.get('/', async (req, res) => {
  const name = typeof req.query.name === 'string' ? cleanPlayerName(req.query.name) : ''
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const claim = await getClaim(name)
  if (!claim?.accountId) {
    res.json({ pages: STICKER_PAGES.map((p) => ({ id: p.id, got: [], full: false })) })
    return
  }
  const pages = await stickerPages(claim.accountId, name)
  // A full page pays its owner once (the ledger keeps it to one), as they look at their own card.
  const viewer = await accountFromRequest(req)
  if (viewer?.id === claim.accountId) {
    for (const page of pages.filter((p) => p.full)) {
      await awardTickets(claim.accountId, 'stickers', `page:${page.id}`, STICKER_PAGE_TICKETS).catch(() => undefined)
    }
  }
  res.json({ pages, pageTickets: STICKER_PAGE_TICKETS })
})
