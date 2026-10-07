import { and, eq, gt, gte, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { accounts, appMeta, memberships, prizesOwned, seasonPlus, seasonProgress, ticketLedger, trophyAwards } from './db/schema.js'
import { getClaim, namesOwnedByAccount, resolveAvatarId } from './names.js'
import { notify } from './notifications.js'
import { prizeById } from './prizes.js'
import { boardDateKey, dayStartMs, globalRanksForWindow, type GlobalRankEntry } from './store.js'
import { awardTickets } from './tickets.js'
import { keptDaysFor } from './today.js'
import { ordinal } from './words.js'

/*
 * Seasons: a stretch of about nine weeks with a theme, a free pass of 30 levels and looks to win on it.
 * Ramsey's son put the idea to him ("seasons and skins and things, like fortnite does"); Ramsey picked
 * Space Race for the first, to start with the site's launch on Oct 31 (2026-10-02).
 *
 * The pass is moved by tickets: every ticket won in the season counts, spending them takes nothing back,
 * and a level comes every `perLevel` of them. Tickets a level itself gives (reason 'season') and an admin's
 * grants don't count. Nothing here touches a score: the rewards are looks and tickets, and level 1 comes
 * with the first ticket of the season, so everyone who plays gets the season's patch.
 *
 * Where a player has got to lives in the ledger; season_progress only remembers what the last look saw, so
 * a run can say what it added and when it reached a new level, and each level's rewards are given once.
 * A reward the code can't give yet (a skin, the patch, a look still being drawn) is given by the first
 * look after it can: the Season page asks for that catch-up.
 */

export type SeasonRewardKind = 'pin' | 'prize' | 'tickets' | 'skin'

export type SeasonReward = {
  level: number
  kind: SeasonRewardKind
  /** A prize id (prizes.ts), a skin's id, the pin's id, or tickets-<level>. */
  id: string
  name: string
  /** What it is, for its tile: "Title", "Lander ship". */
  what: string
  amount?: number
  /** The game a skin is for. */
  game?: string
  /** On the Pass+ row: given only to a player who has the season's Pass+. */
  plus?: boolean
}

export type SeasonDef = {
  id: number
  slug: string
  name: string
  /** The boards' days (America/New_York) it runs, first and last, YYYYMMDD. */
  firstDay: number
  lastDay: number
  levels: number
  perLevel: number
  /** The games it puts forward, which its skins are for. */
  spotlight: string[]
  rewards: SeasonReward[]
  /** Extra things to do in it, on top of the pass, each with its own reward. */
  goals: SeasonGoal[]
  /**
   * Its Pass+: a second row of looks on the same levels, bought once for the season (payments.ts). Looks
   * only, never score, and never a pin or a ring, which are only ever earned. What's on it is kept for good.
   */
  plus: {
    price: number
    currency: string
    rewards: SeasonReward[]
    /** Levels past the last that only Pass+ climbs, each another `perLevel` tickets. */
    bonus: number
  } | null
}

export type SeasonGoal = {
  /** dailies: days the Dailies were kept in the season; games: different games that paid run tickets in it. */
  id: 'dailies' | 'games'
  title: string
  need: number
  reward: { kind: 'prize'; id: string; name: string } | { kind: 'tickets'; amount: number; name: string }
}

function tickets(level: number, amount: number): SeasonReward {
  return { level, kind: 'tickets', id: `tickets-${level}`, name: `${amount} tickets`, what: 'Tickets', amount }
}

const SPACE_RACE: SeasonReward[] = [
  { level: 1, kind: 'pin', id: 's1', name: 'Season 1 patch', what: 'Pin' },
  { level: 2, kind: 'prize', id: 'nm-starlight', name: 'Starlight', what: 'Name style' },
  tickets(3, 50),
  { level: 4, kind: 'prize', id: 'orbit', name: 'Orbit', what: 'Badge finish' },
  { level: 5, kind: 'prize', id: 't-space-race', name: 'Space Race', what: 'Title' },
  { level: 6, kind: 'prize', id: 'cd-deepfield', name: 'Deep field', what: 'Card theme' },
  { level: 7, kind: 'prize', id: 'cf-stardust', name: 'Stardust', what: 'Confetti' },
  { level: 8, kind: 'skin', id: 'lander-moonhopper', name: 'Moonhopper', what: 'Lander ship', game: 'lander' },
  tickets(9, 75),
  { level: 10, kind: 'prize', id: 't-liftoff', name: 'Liftoff', what: 'Title' },
  { level: 11, kind: 'prize', id: 'nm-countdown', name: 'Countdown', what: 'Name style' },
  { level: 12, kind: 'skin', id: 'asteroids-comet', name: 'Comet', what: 'Asteroids ship', game: 'asteroids' },
  tickets(13, 100),
  { level: 14, kind: 'prize', id: 'ringed', name: 'Ringed planet', what: 'Badge finish' },
  { level: 15, kind: 'skin', id: 'barrage-nova', name: 'Nova fighter', what: 'Barrage ship', game: 'barrage' },
  { level: 16, kind: 'prize', id: 't-space-cadet', name: 'Space Cadet', what: 'Title' },
  { level: 17, kind: 'prize', id: 'cd-launchpad', name: 'Launch pad', what: 'Card theme' },
  tickets(18, 100),
  { level: 19, kind: 'skin', id: 'hotlap-rocket', name: 'Rocket car', what: 'Hot Lap car', game: 'hotlap' },
  { level: 20, kind: 'prize', id: 'cf-shooting', name: 'Shooting stars', what: 'Confetti' },
  { level: 21, kind: 'prize', id: 't-zero-g', name: 'Zero G', what: 'Title' },
  { level: 22, kind: 'prize', id: 'mission', name: 'Mission patch', what: 'Badge finish' },
  tickets(23, 150),
  { level: 24, kind: 'prize', id: 'nm-nebula', name: 'Nebula', what: 'Name style' },
  { level: 25, kind: 'skin', id: 'snake-comet-tail', name: 'Blazing comet', what: 'Snake skin', game: 'snake' },
  { level: 26, kind: 'prize', id: 't-moonwalker', name: 'Moonwalker', what: 'Title' },
  tickets(27, 150),
  { level: 28, kind: 'prize', id: 'sign-liftoff', name: 'Liftoff sign', what: 'Wall sign' },
  { level: 29, kind: 'prize', id: 'cd-nebula', name: 'Nebula', what: 'Card theme' },
  { level: 30, kind: 'prize', id: 'supernova', name: 'Supernova', what: 'Badge finish' },
]

/**
 * Season 1's Pass+ row: a reward on two of every three levels (Ramsey: a fuller row, 2026-10-03), ten skins
 * across the five skin games and fifteen looks, then five bonus levels only Pass+ climbs to.
 */
const SPACE_RACE_PLUS: SeasonReward[] = [
  { level: 1, kind: 'skin', id: 'asteroids-shuttle', name: 'Shuttle', what: 'Asteroids ship', game: 'asteroids', plus: true },
  { level: 2, kind: 'prize', id: 't-flight-director', name: 'Flight Director', what: 'Title', plus: true },
  { level: 4, kind: 'prize', id: 'nm-aurora', name: 'Aurora', what: 'Name style', plus: true },
  { level: 5, kind: 'prize', id: 'nm-telemetry', name: 'Telemetry', what: 'Name style', plus: true },
  { level: 7, kind: 'skin', id: 'lander-eagle', name: 'Eagle', what: 'Lander ship', game: 'lander', plus: true },
  { level: 8, kind: 'prize', id: 'cd-porthole', name: 'Porthole', what: 'Card theme', plus: true },
  { level: 10, kind: 'prize', id: 'cd-mission', name: 'Mission control', what: 'Card theme', plus: true },
  { level: 11, kind: 'skin', id: 'hotlap-sunracer', name: 'Shuttle car', what: 'Hot Lap car', game: 'hotlap', plus: true },
  { level: 13, kind: 'skin', id: 'barrage-ringship', name: 'Ringship', what: 'Barrage ship', game: 'barrage', plus: true },
  { level: 14, kind: 'prize', id: 'cf-splashdown', name: 'Splashdown', what: 'Confetti', plus: true },
  { level: 16, kind: 'prize', id: 'cf-meteors', name: 'Meteor shower', what: 'Confetti', plus: true },
  { level: 17, kind: 'skin', id: 'barrage-stingray', name: 'Stingray', what: 'Barrage ship', game: 'barrage', plus: true },
  { level: 19, kind: 'skin', id: 'snake-nebula-tail', name: 'Astro worm', what: 'Snake skin', game: 'snake', plus: true },
  { level: 20, kind: 'prize', id: 'blue-marble', name: 'Blue marble', what: 'Badge finish', plus: true },
  { level: 22, kind: 'skin', id: 'hotlap-midnight', name: 'Moon buggy', what: 'Hot Lap car', game: 'hotlap', plus: true },
  { level: 23, kind: 'skin', id: 'snake-saturn-tail', name: 'Saturn tail', what: 'Snake skin', game: 'snake', plus: true },
  { level: 25, kind: 'prize', id: 't-commander', name: 'Commander', what: 'Title', plus: true },
  { level: 26, kind: 'prize', id: 't-ace-pilot', name: 'Ace Pilot', what: 'Title', plus: true },
  { level: 29, kind: 'prize', id: 'cd-station', name: 'Space station', what: 'Card theme', plus: true },
  { level: 30, kind: 'prize', id: 'eclipse', name: 'Eclipse', what: 'Badge finish', plus: true },
  // The bonus levels, past the free row's last.
  { level: 31, kind: 'skin', id: 'asteroids-orbiter', name: 'Orbiter', what: 'Asteroids ship', game: 'asteroids', plus: true },
  { level: 32, kind: 'skin', id: 'lander-starhopper', name: 'Starhopper', what: 'Lander ship', game: 'lander', plus: true },
  { level: 33, kind: 'prize', id: 'nm-wormhole', name: 'Wormhole', what: 'Name style', plus: true },
  { level: 34, kind: 'prize', id: 'black-hole', name: 'Black hole', what: 'Badge finish', plus: true },
  { level: 35, kind: 'prize', id: 't-legend', name: 'Space Race Legend', what: 'Title', plus: true },
]

/**
 * Season 2, Cold Snap: winter, from the day after Space Race's last, so a pass is always running (Ramsey wants
 * seasons back to back, 2026-10-06). The same shape as Season 1's: a skin for each of its skin games, looks
 * between, tickets every few levels, and the patch at level 1. Skins go round the games a season at a time
 * (Ramsey, 2026-10-07): Cold Snap's are Hot Lap's and Snake's, and Swoop's, Marble Run's and Pileup's for the
 * first time, and its spotlight is the games with new skins.
 */
const COLD_SNAP: SeasonReward[] = [
  { level: 1, kind: 'pin', id: 's2', name: 'Season 2 patch', what: 'Pin' },
  { level: 2, kind: 'prize', id: 'nm-frost', name: 'Frost', what: 'Name style' },
  tickets(3, 50),
  { level: 4, kind: 'prize', id: 'snowflake', name: 'Snowflake', what: 'Badge finish' },
  { level: 5, kind: 'prize', id: 't-cold-snap', name: 'Cold Snap', what: 'Title' },
  { level: 6, kind: 'prize', id: 'cd-snowfield', name: 'Snowfield', what: 'Card theme' },
  { level: 7, kind: 'prize', id: 'cf-snowfall', name: 'Snowfall', what: 'Confetti' },
  { level: 8, kind: 'skin', id: 'swoop-snow-swift', name: 'Snow swift', what: 'Swoop bird', game: 'swoop' },
  tickets(9, 75),
  { level: 10, kind: 'prize', id: 't-snow-day', name: 'Snow Day', what: 'Title' },
  { level: 11, kind: 'prize', id: 'nm-frostbite', name: 'Frostbite', what: 'Name style' },
  { level: 12, kind: 'skin', id: 'marblerun-snowball', name: 'Snowball', what: 'Marble Run marble', game: 'marblerun' },
  tickets(13, 100),
  { level: 14, kind: 'prize', id: 'igloo', name: 'Igloo', what: 'Badge finish' },
  { level: 15, kind: 'skin', id: 'pileup-ice-cubes', name: 'Ice cubes', what: 'Pileup blocks', game: 'pileup' },
  { level: 16, kind: 'prize', id: 't-hot-cocoa', name: 'Hot Cocoa', what: 'Title' },
  { level: 17, kind: 'prize', id: 'cd-ski-lodge', name: 'Ski lodge', what: 'Card theme' },
  tickets(18, 100),
  { level: 19, kind: 'skin', id: 'hotlap-ice-rocket', name: 'Bobsled', what: 'Hot Lap car', game: 'hotlap' },
  { level: 20, kind: 'prize', id: 'cf-snowballs', name: 'Snowballs', what: 'Confetti' },
  { level: 21, kind: 'prize', id: 't-first-frost', name: 'First Frost', what: 'Title' },
  { level: 22, kind: 'prize', id: 'snowman', name: 'Snowman', what: 'Badge finish' },
  tickets(23, 150),
  { level: 24, kind: 'prize', id: 'nm-glacier', name: 'Glacier', what: 'Name style' },
  { level: 25, kind: 'skin', id: 'snake-snowdrift-tail', name: 'Snowdrift tail', what: 'Snake skin', game: 'snake' },
  { level: 26, kind: 'prize', id: 't-snow-bunny', name: 'Snow Bunny', what: 'Title' },
  tickets(27, 150),
  { level: 28, kind: 'prize', id: 'sign-cold-snap', name: 'Cold Snap sign', what: 'Wall sign' },
  { level: 29, kind: 'prize', id: 'cd-pine-forest', name: 'Pine forest', what: 'Card theme' },
  { level: 30, kind: 'prize', id: 'blizzard', name: 'Blizzard', what: 'Badge finish' },
]

/** Season 2's Pass+ row: as Season 1's, ten skins and fifteen looks on two of every three levels, then five bonus levels. */
const COLD_SNAP_PLUS: SeasonReward[] = [
  { level: 1, kind: 'skin', id: 'swoop-penguin', name: 'Penguin', what: 'Swoop bird', game: 'swoop', plus: true },
  { level: 2, kind: 'prize', id: 't-snow-angel', name: 'Snow Angel', what: 'Title', plus: true },
  { level: 4, kind: 'prize', id: 'nm-hoarfrost', name: 'Hoarfrost', what: 'Name style', plus: true },
  { level: 5, kind: 'prize', id: 'nm-polar', name: 'Polar', what: 'Name style', plus: true },
  { level: 7, kind: 'skin', id: 'marblerun-ice-marble', name: 'Ice marble', what: 'Marble Run marble', game: 'marblerun', plus: true },
  { level: 8, kind: 'prize', id: 'cd-frozen-lake', name: 'Frozen lake', what: 'Card theme', plus: true },
  { level: 10, kind: 'prize', id: 'cd-ice-cave', name: 'Ice cave', what: 'Card theme', plus: true },
  { level: 11, kind: 'skin', id: 'hotlap-whiteout', name: 'Crystal car', what: 'Hot Lap car', game: 'hotlap', plus: true },
  { level: 13, kind: 'skin', id: 'pileup-knitted', name: 'Knitted', what: 'Pileup blocks', game: 'pileup', plus: true },
  { level: 14, kind: 'prize', id: 'cf-icicles', name: 'Icicles', what: 'Confetti', plus: true },
  { level: 16, kind: 'prize', id: 'cf-flurry', name: 'Flurry', what: 'Confetti', plus: true },
  { level: 17, kind: 'skin', id: 'marblerun-polar-night', name: 'Polar night', what: 'Marble Run marble', game: 'marblerun', plus: true },
  { level: 19, kind: 'skin', id: 'snake-aurora-tail', name: 'Aurora serpent', what: 'Snake skin', game: 'snake', plus: true },
  { level: 20, kind: 'prize', id: 'polar-bear', name: 'Polar bear', what: 'Badge finish', plus: true },
  { level: 22, kind: 'skin', id: 'hotlap-borealis', name: 'Aurora glider', what: 'Hot Lap car', game: 'hotlap', plus: true },
  { level: 23, kind: 'skin', id: 'snake-fireside-tail', name: 'Ice dragon', what: 'Snake skin', game: 'snake', plus: true },
  { level: 25, kind: 'prize', id: 't-ice-cold', name: 'Ice Cold', what: 'Title', plus: true },
  { level: 26, kind: 'prize', id: 't-polar-explorer', name: 'Polar Explorer', what: 'Title', plus: true },
  { level: 29, kind: 'prize', id: 'cd-northern-lights', name: 'Northern lights', what: 'Card theme', plus: true },
  { level: 30, kind: 'prize', id: 'diamond-dust', name: 'Diamond dust', what: 'Badge finish', plus: true },
  // The bonus levels, past the free row's last.
  { level: 31, kind: 'skin', id: 'swoop-aurora-phoenix', name: 'Aurora phoenix', what: 'Swoop bird', game: 'swoop', plus: true },
  { level: 32, kind: 'skin', id: 'pileup-northern-lights', name: 'Northern lights', what: 'Pileup blocks', game: 'pileup', plus: true },
  { level: 33, kind: 'prize', id: 'nm-crystal', name: 'Crystal', what: 'Name style', plus: true },
  { level: 34, kind: 'prize', id: 'ice-crown', name: 'Ice crown', what: 'Badge finish', plus: true },
  { level: 35, kind: 'prize', id: 't-cold-legend', name: 'Cold Snap Legend', what: 'Title', plus: true },
]

export const SEASONS: readonly SeasonDef[] = [
  {
    id: 1,
    slug: 'space-race',
    name: 'Space Race',
    firstDay: 20261031,
    lastDay: 20270104,
    levels: 30,
    perLevel: 150,
    spotlight: ['lander', 'asteroids', 'barrage'],
    rewards: SPACE_RACE,
    goals: [
      { id: 'dailies', title: 'Keep the Dailies on 30 days', need: 30, reward: { kind: 'prize', id: 't-regular', name: 'The Regular title' } },
      { id: 'games', title: 'Win tickets in 12 different games', need: 12, reward: { kind: 'tickets', amount: 200, name: '200 tickets' } },
    ],
    // $2.99 for the season, the same as a month of Plus, so joining Plus for a month and leaving is no cheaper (Ramsey, 2026-10-04).
    plus: { price: 299, currency: 'usd', rewards: SPACE_RACE_PLUS, bonus: 5 },
  },
  {
    id: 2,
    slug: 'cold-snap',
    name: 'Cold Snap',
    // The day after Space Race's last, to Mar 8: nine weeks.
    firstDay: 20270105,
    lastDay: 20270308,
    levels: 30,
    perLevel: 150,
    spotlight: ['hotlap', 'swoop', 'marblerun'],
    rewards: COLD_SNAP,
    goals: [
      { id: 'dailies', title: 'Keep the Dailies on 30 days', need: 30, reward: { kind: 'prize', id: 't-snowbound', name: 'The Snowbound title' } },
      { id: 'games', title: 'Win tickets in 12 different games', need: 12, reward: { kind: 'tickets', amount: 200, name: '200 tickets' } },
    ],
    plus: { price: 299, currency: 'usd', rewards: COLD_SNAP_PLUS, bonus: 5 },
  },
]

export type SeasonStatus = 'live' | 'upcoming' | 'over'

export type SeasonNow = {
  def: SeasonDef
  startsAt: number
  endsAt: number
  status: SeasonStatus
  /** Live early, because an admin turned the preview on (testing it before its first day). */
  preview: boolean
}

function nextDayKey(key: number): number {
  const d = new Date(Date.UTC(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, (key % 100) + 1))
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

export function dayLabel(key: number): string {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/* ---------- the early preview: live before its first day, for trying it on staging ---------- */

const PREVIEW_KEY = 'season_preview'
const FRESH_MS = 30_000

/**
 * The early preview: the day it counts from (YYYYMMDD), and the season it shows, when an admin picked one
 * ('YYYYMMDD:2' in app_meta). Without one, the next season to come is live early; with one, that season is
 * live from the day, over any other, so the season after the live one can be tried before it comes.
 */
export type SeasonPreview = { from: number; season: number | null }

let previewKnown: { preview: SeasonPreview | null; at: number } | null = null
let previewAsking: Promise<SeasonPreview | null> | null = null

function readPreview(value: string): SeasonPreview | null {
  const m = /^(\d{8})(?::(\d+))?$/.exec(value)
  return m ? { from: Number(m[1]), season: m[2] ? Number(m[2]) : null } : null
}

/** The early preview, or null when it's off. */
export async function seasonPreview(now = Date.now()): Promise<SeasonPreview | null> {
  if (previewKnown && now - previewKnown.at < FRESH_MS) return previewKnown.preview
  previewAsking ??= db()
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, PREVIEW_KEY))
    .limit(1)
    .then(([row]) => {
      const preview = row ? readPreview(row.value) : null
      previewKnown = { preview, at: Date.now() }
      return preview
    })
    .catch(() => previewKnown?.preview ?? null)
    .finally(() => {
      previewAsking = null
    })
  return previewAsking
}

/** The day an early preview counts from (YYYYMMDD), or null when it's off. */
export async function seasonPreviewFrom(now = Date.now()): Promise<number | null> {
  return (await seasonPreview(now))?.from ?? null
}

/** Turn the preview on, counting from the first of this month (of `season`, when one is picked), or off. */
export async function setSeasonPreview(on: boolean, now = Date.now(), season: number | null = null): Promise<SeasonPreview | null> {
  if (!on) {
    await db().delete(appMeta).where(eq(appMeta.key, PREVIEW_KEY))
    previewKnown = { preview: null, at: Date.now() }
    return null
  }
  const pick = season != null && SEASONS.some((s) => s.id === season) ? season : null
  const preview = { from: Math.floor(boardDateKey(now) / 100) * 100 + 1, season: pick }
  const value = pick != null ? `${preview.from}:${pick}` : String(preview.from)
  await db().insert(appMeta).values({ key: PREVIEW_KEY, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } })
  previewKnown = { preview, at: Date.now() }
  return preview
}

/* ---------- which season it is ---------- */

/** The live season, else the next to come, else the last one over; null when there are none. */
export async function seasonNow(now = Date.now()): Promise<SeasonNow | null> {
  const preview = await seasonPreview(now)
  const previewFrom = preview?.from ?? null
  // A season an admin picked to preview is live from the preview's day, over any other, until it ends.
  const picked = preview?.season != null ? SEASONS.find((s) => s.id === preview.season) : undefined
  if (picked && previewFrom != null) {
    const realStart = dayStartMs(picked.firstDay)
    const endsAt = dayStartMs(nextDayKey(picked.lastDay))
    if (now < realStart && now >= dayStartMs(previewFrom)) return { def: picked, startsAt: dayStartMs(previewFrom), endsAt, status: 'live', preview: true }
  }
  let next: SeasonNow | null = null
  let last: SeasonNow | null = null
  for (const def of SEASONS) {
    const realStart = dayStartMs(def.firstDay)
    const endsAt = dayStartMs(nextDayKey(def.lastDay))
    const early = !picked && previewFrom != null && now < realStart && now >= dayStartMs(previewFrom)
    const startsAt = early ? dayStartMs(previewFrom) : realStart
    if (now >= startsAt && now < endsAt) return { def, startsAt, endsAt, status: 'live', preview: early }
    if (now < startsAt) {
      if (!next || startsAt < next.startsAt) next = { def, startsAt, endsAt, status: 'upcoming', preview: false }
    } else if (!last || endsAt > last.endsAt) {
      last = { def, startsAt, endsAt, status: 'over', preview: false }
    }
  }
  return next ?? last
}

/* ---------- a player's place on the pass ---------- */

/** Ledger reasons that don't move the pass: a level's own tickets, and an admin's grant. */
const NOT_COUNTED = ['season', 'grant']

export async function seasonEarned(accountId: string, startsAt: number, endsAt: number): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${ticketLedger.amount}), 0)::int` })
    .from(ticketLedger)
    .where(
      and(
        eq(ticketLedger.accountId, accountId),
        gt(ticketLedger.amount, 0),
        gte(ticketLedger.at, startsAt),
        lt(ticketLedger.at, endsAt),
        notInArray(ticketLedger.reason, NOT_COUNTED),
      ),
    )
  return Number(row?.total ?? 0)
}

/** The highest level a player's pass reaches: the last, and with Pass+ its bonus levels too. */
export function topLevel(def: SeasonDef, plus = false): number {
  return def.levels + (plus && def.plus ? def.plus.bonus : 0)
}

/** Level 0 before the season's first ticket, then one more every `perLevel`, to the last (or the bonus levels' last with Pass+). */
export function levelFor(def: SeasonDef, earned: number, plus = false): number {
  if (earned <= 0) return 0
  return Math.min(topLevel(def, plus), 1 + Math.floor(earned / def.perLevel))
}

/** Season tickets the next level needs, all told, or null at the last. */
export function nextLevelAt(def: SeasonDef, level: number, plus = false): number | null {
  return level >= topLevel(def, plus) ? null : Math.max(0, level) * def.perLevel
}

/**
 * Skins the site's games can draw (its lib/skins.ts). A skin is owned like a prize, a row in prizes_owned
 * under its id, but it isn't in the counter's catalogue: it's chosen on its game's page, never worn on the
 * avatar, and never sold.
 */
const SKINS_DRAWN = new Set([
  'lander-moonhopper',
  'asteroids-comet',
  'barrage-nova',
  'hotlap-rocket',
  'snake-comet-tail',
  // Season 1's Pass+ row.
  'asteroids-shuttle',
  'lander-eagle',
  'barrage-ringship',
  'snake-nebula-tail',
  'hotlap-midnight',
  'hotlap-sunracer',
  'barrage-stingray',
  'snake-saturn-tail',
  'asteroids-orbiter',
  'lander-starhopper',
  // Season 2's, free row and Pass+.
  'swoop-snow-swift',
  'marblerun-snowball',
  'pileup-ice-cubes',
  'swoop-penguin',
  'marblerun-ice-marble',
  'pileup-knitted',
  'marblerun-polar-night',
  'swoop-aurora-phoenix',
  'pileup-northern-lights',
  // Drawn for Season 2 first, sitting it out now: on no pass, kept for a later season.
  'lander-icebreaker',
  'asteroids-icicle',
  'barrage-snowbird',
  'hotlap-ice-rocket',
  'snake-snowdrift-tail',
  'asteroids-ice-crystal',
  'lander-gondola',
  'hotlap-whiteout',
  'barrage-snowy-owl',
  'asteroids-north-star',
  'snake-aurora-tail',
  'hotlap-borealis',
  'snake-fireside-tail',
  'barrage-frost-dragon',
  'lander-yeti',
])

/** Every skin a season gives, free row and Pass+, and its game: what a saved run may say it was played in. */
export const SEASON_SKINS: ReadonlyMap<string, string> = new Map(
  SEASONS.flatMap((def) => [...def.rewards, ...(def.plus?.rewards ?? [])])
    .filter((r) => r.kind === 'skin' && r.game)
    .map((r) => [r.id, r.game!] as const),
)

/**
 * Whether this build can give a reward yet: tickets always; a prize once the catalogue has it; a skin once
 * its game draws it; the patch always, as it's flair, worn by whoever won a ticket in the season (flair.ts),
 * with nothing to hand out.
 */
export function rewardReady(reward: SeasonReward): boolean {
  if (reward.kind === 'tickets' || reward.kind === 'pin') return true
  if (reward.kind === 'prize') return prizeById(reward.id) != null
  return SKINS_DRAWN.has(reward.id)
}

/**
 * How a player has a season's Pass+: bought for it ('pass'), or as a Plus member ('plus': Plus includes every
 * season's, Ramsey's pick, 2026-10-03); null without it. What a membership gave stays given when it ends.
 */
export async function plusOf(accountId: string, season: number): Promise<'pass' | 'plus' | null> {
  const [row] = await db()
    .select({ at: seasonPlus.at })
    .from(seasonPlus)
    .where(and(eq(seasonPlus.accountId, accountId), eq(seasonPlus.season, season)))
    .limit(1)
  if (row) return 'pass'
  const [account] = await db()
    .select({ plan: accounts.plan, status: memberships.status })
    .from(accounts)
    .leftJoin(memberships, eq(memberships.accountId, accounts.id))
    .where(eq(accounts.id, accountId))
    .limit(1)
  // Plus's free week gives no Pass+: its rewards are kept for good, so they come with the first payment (plus.ts TRIAL_DAYS).
  return account?.plan === 'plus' && account.status !== 'trialing' ? 'plus' : null
}

/** Whether a player has a season's Pass+, bought or with Plus. */
export async function hasPlus(accountId: string, season: number): Promise<boolean> {
  return (await plusOf(accountId, season)) != null
}

/** The rewards a player's pass gives: the free row, and the Pass+ row too with Pass+. */
function laneOf(def: SeasonDef, plus: boolean): SeasonReward[] {
  return plus && def.plus ? [...def.rewards, ...def.plus.rewards] : def.rewards
}

async function giveRewards(accountId: string, def: SeasonDef, rewards: SeasonReward[], from: number, to: number, now: number) {
  for (const reward of rewards) {
    if (reward.level < from || reward.level > to || !rewardReady(reward)) continue
    if (reward.kind === 'tickets') {
      await awardTickets(accountId, 'season', `s${def.id}:lv${reward.level}`, reward.amount ?? 0, null, now)
    } else if (reward.kind === 'prize' || reward.kind === 'skin') {
      await db().insert(prizesOwned).values({ accountId, prizeId: reward.id, price: 0, at: now }).onConflictDoNothing()
    }
  }
}

export type SeasonSync = {
  season: SeasonNow
  earned: number
  /** What the last look saw, so a run can say what it added. */
  before: number
  level: number
  /** The rewards of every level reached since the last look: the Pass+ row's too, with Pass+. */
  reached: SeasonReward[]
  plus: boolean
  /** The last level the player was told of (a run's report, or the site's level-up: POST /season/seen). */
  announced: number
}

/**
 * Where a player is on the live season's pass, giving any level's rewards they've reached since the last
 * look. `catchUp` gives every reward up to their level that hasn't been, for rewards that came in a later
 * release than the level did. Null when no season is live.
 *
 * Only a saved run (`announce`) moves the level kept here: a page asking gives the rewards but leaves it,
 * so a level reached between runs (a bug found, a day's top paid) is still the next run's to announce.
 */
export async function syncSeason(
  accountId: string,
  now = Date.now(),
  { catchUp = false, announce = true } = {},
): Promise<SeasonSync | null> {
  const season = await seasonNow(now)
  if (!season || season.status !== 'live') return null
  const { def } = season
  const earned = await seasonEarned(accountId, season.startsAt, season.endsAt)
  const plus = def.plus ? await hasPlus(accountId, def.id) : false
  const level = levelFor(def, earned, plus)
  const [last] = await db()
    .select({ earned: seasonProgress.earned, level: seasonProgress.level })
    .from(seasonProgress)
    .where(and(eq(seasonProgress.accountId, accountId), eq(seasonProgress.season, def.id)))
    .limit(1)
  const before = last?.earned ?? 0
  const lastLevel = last?.level ?? 0
  const lane = laneOf(def, plus)
  if (level > lastLevel || (catchUp && level > 0)) {
    await giveRewards(accountId, def, lane, catchUp ? 1 : lastLevel + 1, level, now)
  }
  const keptLevel = announce ? Math.max(level, lastLevel) : lastLevel
  if (!last || last.earned !== earned || last.level !== keptLevel) {
    await db()
      .insert(seasonProgress)
      .values({ accountId, season: def.id, earned, level: keptLevel, updatedAt: now })
      .onConflictDoUpdate({
        target: [seasonProgress.accountId, seasonProgress.season],
        set: announce ? { earned, level: sql`greatest(${seasonProgress.level}, ${level})`, updatedAt: now } : { earned, updatedAt: now },
      })
  }
  const reached = lane.filter((r) => r.level > lastLevel && r.level <= level)
  return { season, earned, before, level, reached, plus, announced: keptLevel }
}

/**
 * Gives a player a season's Pass+ (a payment, or an admin), once, and at once every Pass+ reward up to the
 * level they're at. True when it's new; false when they had it already.
 */
export async function grantPlus(
  accountId: string,
  seasonId: number,
  how: { source: 'stripe' | 'grant'; ref?: string | null; amount?: number | null; currency?: string | null },
  now = Date.now(),
): Promise<boolean> {
  const def = SEASONS.find((s) => s.id === seasonId)
  if (!def?.plus) throw Object.assign(new Error('That season has no Pass+'), { status: 404, code: 'NO_PLUS' })
  const added = await db()
    .insert(seasonPlus)
    .values({ accountId, season: seasonId, source: how.source, ref: how.ref ?? null, amount: how.amount ?? null, currency: how.currency ?? null, at: now })
    .onConflictDoNothing()
    .returning({ at: seasonPlus.at })
  if (!added.length) return false
  const startsAt = dayStartMs(def.firstDay)
  const endsAt = dayStartMs(nextDayKey(def.lastDay))
  const season = await seasonNow(now)
  const window = season && season.def.id === seasonId ? season : { startsAt, endsAt }
  // Bought before the season's first ticket: level 1's Pass+ reward comes with it all the same.
  const level = Math.max(1, levelFor(def, await seasonEarned(accountId, window.startsAt, window.endsAt), true))
  await giveRewards(accountId, def, def.plus.rewards, 1, level, now)
  return true
}

/** Takes a season's Pass+ back (an admin's grant, for trying it out). What it gave stays given. */
export async function revokePlus(accountId: string, seasonId: number): Promise<boolean> {
  const gone = await db()
    .delete(seasonPlus)
    .where(and(eq(seasonPlus.accountId, accountId), eq(seasonPlus.season, seasonId)))
    .returning({ at: seasonPlus.at })
  return gone.length > 0
}

/* ---------- what the site is sent ---------- */

export type SeasonInfo = {
  id: number
  slug: string
  name: string
  firstDay: string
  lastDay: string
  startsAt: number
  endsAt: number
  status: SeasonStatus
  preview: boolean
  /** Board days left, today included. */
  daysLeft: number
  levels: number
  perLevel: number
  spotlight: string[]
}

export type SeasonRewardView = SeasonReward & { ready: boolean }

/**
 * Where a player is on the pass. `announced` is the last level they were told of; past it, `pending` are the
 * rewards of the levels they've reached since, which the site tells them of once (POST /season/seen). Levels
 * reached by tickets that came with no run report (a bug caught, a day's place paid at midnight, a record on
 * a past course) wait here.
 */
export type SeasonYou = {
  earned: number
  level: number
  nextAt: number | null
  announced?: number
  pending?: SeasonRewardView[]
}

/** What a run did on the pass, for the run report. */
export type SeasonRun = {
  id: number
  name: string
  earned: number
  added: number
  level: number
  levels: number
  nextAt: number | null
  /** The next level's first reward, to say what the run is heading for. */
  next: SeasonRewardView | null
  /** Every reward of the levels the run reached, when it reached one. */
  levelUp: SeasonRewardView[]
}

const DAY_MS = 86_400_000

export function seasonInfo(season: SeasonNow, now = Date.now()): SeasonInfo {
  const { def } = season
  const daysLeft = season.status === 'over' ? 0 : Math.max(0, Math.ceil((season.endsAt - Math.max(now, season.startsAt)) / DAY_MS))
  return {
    id: def.id,
    slug: def.slug,
    name: def.name,
    firstDay: dayLabel(def.firstDay),
    lastDay: dayLabel(def.lastDay),
    startsAt: season.startsAt,
    endsAt: season.endsAt,
    status: season.status,
    preview: season.preview,
    daysLeft,
    levels: def.levels,
    perLevel: def.perLevel,
    spotlight: def.spotlight,
  }
}

export function rewardView(reward: SeasonReward): SeasonRewardView {
  return { ...reward, ready: rewardReady(reward) }
}

/** The pass after a saved run: null when no season is live, or on any failure (a save never waits on it). */
export async function seasonAfterRun(accountId: string, now = Date.now()): Promise<SeasonRun | null> {
  const sync = await syncSeason(accountId, now)
  if (!sync) return null
  const { def } = sync.season
  const nextAt = nextLevelAt(def, sync.level, sync.plus)
  const next = laneOf(def, sync.plus).find((r) => r.level === sync.level + 1)
  return {
    id: def.id,
    name: def.name,
    earned: sync.earned,
    added: Math.max(0, sync.earned - sync.before),
    level: sync.level,
    levels: topLevel(def, sync.plus),
    nextAt,
    next: next ? rewardView(next) : null,
    levelUp: sync.reached.map(rewardView),
  }
}

/* ---------- the season's standings ---------- */

/** Places that win when a season ends: the cup for the top three, a trophy for the rest of the top ten. */
export const CUP_PLACES = 3
export const TROPHY_PLACES = 10
/**
 * Players a season's standings need before its trophies are given, as an event's field does
 * (tournaments.ts): a cup in a field of two isn't one, nor a top ten of twelve.
 */
export const CUP_FIELD = 5
export const TROPHY_FIELD = 15

const STANDINGS_FRESH_MS = 5 * 60_000
const standingsKept = new Map<number, { at: number; rows: GlobalRankEntry[] }>()
const standingsAsked = new Map<number, Promise<GlobalRankEntry[]>>()

/** The season's standings (points from each player's ten best games over its days), counted at most every five minutes. */
export async function seasonStandingRows(season: SeasonNow, now = Date.now()): Promise<GlobalRankEntry[]> {
  const id = season.def.id
  const kept = standingsKept.get(id)
  if (kept && (season.status === 'over' || now - kept.at < STANDINGS_FRESH_MS)) return kept.rows
  let asking = standingsAsked.get(id)
  if (!asking) {
    asking = globalRanksForWindow(season.startsAt, Math.min(season.endsAt, now + 1))
      .then((rows) => {
        standingsKept.set(id, { at: Date.now(), rows })
        return rows
      })
      .finally(() => standingsAsked.delete(id))
    standingsAsked.set(id, asking)
  }
  return asking
}

export type SeasonStandingsView = {
  total: number
  /** The top five, by place and name; the points between them stay on the full Standings. */
  top: { rank: number; name: string; avatarId: string }[]
  you: { rank: number; name: string } | null
  cupPlaces: number
  trophyPlaces: number
}

export async function seasonStandingsView(season: SeasonNow, accountId: string | null, now = Date.now()): Promise<SeasonStandingsView> {
  const rows = await seasonStandingRows(season, now)
  const top = await Promise.all(rows.slice(0, 5).map(async (row) => ({ rank: row.rank, name: row.name, avatarId: await resolveAvatarId(row.name) })))
  let you: SeasonStandingsView['you'] = null
  if (accountId) {
    const tags = new Set((await namesOwnedByAccount(accountId)).map((t) => t.name))
    const mine = rows.find((row) => tags.has(row.name))
    if (mine) you = { rank: mine.rank, name: mine.name }
  }
  return { total: rows.length, top, you, cupPlaces: CUP_PLACES, trophyPlaces: TROPHY_PLACES }
}

/* ---------- the season's goals ---------- */

export type SeasonGoalView = SeasonGoal & { have: number; done: boolean }

const RUN_REASONS = ['run', 'best', 'pickup']

async function goalCount(goal: SeasonGoal, accountId: string, season: SeasonNow, now: number): Promise<number> {
  if (goal.id === 'dailies') {
    const from = boardDateKey(season.startsAt)
    const to = boardDateKey(Math.min(now, season.endsAt - 1))
    let n = 0
    for (const day of await keptDaysFor(accountId, now)) if (day >= from && day <= to) n++
    return n
  }
  const [row] = await db()
    .select({ n: sql<number>`count(distinct ${ticketLedger.game})::int` })
    .from(ticketLedger)
    .where(
      and(
        eq(ticketLedger.accountId, accountId),
        gt(ticketLedger.amount, 0),
        gte(ticketLedger.at, season.startsAt),
        lt(ticketLedger.at, season.endsAt),
        inArray(ticketLedger.reason, RUN_REASONS),
        isNotNull(ticketLedger.game),
      ),
    )
  return Number(row?.n ?? 0)
}

/** Where a player is on each of the season's goals, giving a goal's reward once it's done. */
export async function seasonGoals(accountId: string, season: SeasonNow, now = Date.now()): Promise<SeasonGoalView[]> {
  const { def } = season
  return Promise.all(
    def.goals.map(async (goal) => {
      const have = await goalCount(goal, accountId, season, now)
      const done = have >= goal.need
      if (done && season.status === 'live') {
        if (goal.reward.kind === 'tickets') {
          await awardTickets(accountId, 'season', `s${def.id}:goal:${goal.id}`, goal.reward.amount, null, now)
        } else if (prizeById(goal.reward.id)) {
          await db().insert(prizesOwned).values({ accountId, prizeId: goal.reward.id, price: 0, at: now }).onConflictDoNothing()
        }
      }
      return { ...goal, have: Math.min(have, goal.need), done }
    }),
  )
}

/* ---------- the season's end ---------- */

const SETTLE_WITHIN_MS = 30 * 86_400_000

/**
 * When a season has ended (the sweep asks), its places are given as trophies, once: the cup to its top
 * three and a trophy to the rest of its top ten, each in a field big enough to mean something. Counted
 * over its real days, never a preview's.
 */
export async function settleSeasons(now = Date.now()): Promise<number> {
  let given = 0
  for (const def of SEASONS) {
    const startsAt = dayStartMs(def.firstDay)
    const endsAt = dayStartMs(nextDayKey(def.lastDay))
    if (now < endsAt || now > endsAt + SETTLE_WITHIN_MS) continue
    const key = `season_settled:${def.id}`
    const [done] = await db().select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, key)).limit(1)
    if (done) continue
    const rows = await globalRanksForWindow(startsAt, endsAt)
    const field = rows.length
    const places = field >= TROPHY_FIELD ? TROPHY_PLACES : field >= CUP_FIELD ? CUP_PLACES : 0
    for (const row of rows.slice(0, places)) {
      const accountId = (await getClaim(row.name))?.accountId ?? null
      const inserted = await db()
        .insert(trophyAwards)
        .values({
          id: `season-${def.id}-${row.name}`,
          period: 'season',
          periodKey: def.id,
          name: row.name,
          rank: row.rank,
          score: row.score,
          games: row.games,
          accountId,
          awardedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: trophyAwards.id })
      if (!inserted.length) continue
      given++
      if (accountId) {
        await notify({
          accountId,
          kind: 'trophy',
          title: row.rank <= CUP_PLACES ? `${ordinal(row.rank)} in Season ${def.id}` : `Top ten in Season ${def.id}`,
          body:
            row.rank <= CUP_PLACES
              ? `${def.name} is over, and its cup is on your shelf.`
              : `${def.name} is over: ${ordinal(row.rank)} of ${field}. The trophy is on your shelf.`,
          href: '/rank/all?focus=trophies',
          meta: { trophy: { period: 'season', rank: row.rank } },
          digestKey: `trophy:season:${def.id}`,
          once: true,
          now,
        }).catch(() => undefined)
      }
    }
    await db().insert(appMeta).values({ key, value: String(now) }).onConflictDoNothing()
    console.log(`[season] ${def.name} settled: ${given} trophies in a field of ${field}`)
  }
  return given
}
