import { and, eq, gt, gte, lt, notInArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, prizesOwned, seasonProgress, ticketLedger } from './db/schema.js'
import { prizeById } from './prizes.js'
import { boardDateKey, dayStartMs } from './store.js'
import { awardTickets } from './tickets.js'

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
  { level: 25, kind: 'skin', id: 'snake-comet-tail', name: 'Comet tail', what: 'Snake skin', game: 'snake' },
  { level: 26, kind: 'prize', id: 't-moonwalker', name: 'Moonwalker', what: 'Title' },
  tickets(27, 150),
  { level: 28, kind: 'prize', id: 'sign-liftoff', name: 'Liftoff sign', what: 'Wall sign' },
  { level: 29, kind: 'prize', id: 'cd-nebula', name: 'Nebula', what: 'Card theme' },
  { level: 30, kind: 'prize', id: 'supernova', name: 'Supernova', what: 'Badge finish' },
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
let previewKnown: { from: number | null; at: number } | null = null
let previewAsking: Promise<number | null> | null = null

/** The day an early preview counts from (YYYYMMDD), or null when it's off. */
export async function seasonPreviewFrom(now = Date.now()): Promise<number | null> {
  if (previewKnown && now - previewKnown.at < FRESH_MS) return previewKnown.from
  previewAsking ??= db()
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, PREVIEW_KEY))
    .limit(1)
    .then(([row]) => {
      const from = row && /^\d{8}$/.test(row.value) ? Number(row.value) : null
      previewKnown = { from, at: Date.now() }
      return from
    })
    .catch(() => previewKnown?.from ?? null)
    .finally(() => {
      previewAsking = null
    })
  return previewAsking
}

/** Turn the preview on, counting from the first of this month, or off. */
export async function setSeasonPreview(on: boolean, now = Date.now()): Promise<number | null> {
  if (!on) {
    await db().delete(appMeta).where(eq(appMeta.key, PREVIEW_KEY))
    previewKnown = { from: null, at: Date.now() }
    return null
  }
  const from = Math.floor(boardDateKey(now) / 100) * 100 + 1
  const value = String(from)
  await db().insert(appMeta).values({ key: PREVIEW_KEY, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } })
  previewKnown = { from, at: Date.now() }
  return from
}

/* ---------- which season it is ---------- */

/** The live season, else the next to come, else the last one over; null when there are none. */
export async function seasonNow(now = Date.now()): Promise<SeasonNow | null> {
  const previewFrom = await seasonPreviewFrom(now)
  let next: SeasonNow | null = null
  let last: SeasonNow | null = null
  for (const def of SEASONS) {
    const realStart = dayStartMs(def.firstDay)
    const endsAt = dayStartMs(nextDayKey(def.lastDay))
    const early = previewFrom != null && now < realStart && now >= dayStartMs(previewFrom)
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

/** Level 0 before the season's first ticket, then one more every `perLevel`, to the last. */
export function levelFor(def: SeasonDef, earned: number): number {
  if (earned <= 0) return 0
  return Math.min(def.levels, 1 + Math.floor(earned / def.perLevel))
}

/** Season tickets the next level needs, all told, or null at the last. */
export function nextLevelAt(def: SeasonDef, level: number): number | null {
  return level >= def.levels ? null : Math.max(0, level) * def.perLevel
}

/**
 * Whether this build can give a reward yet: tickets always; a prize once the catalogue has it; the patch
 * always, as it's flair, worn by whoever won a ticket in the season (flair.ts), with nothing to hand out.
 */
export function rewardReady(reward: SeasonReward): boolean {
  if (reward.kind === 'tickets' || reward.kind === 'pin') return true
  if (reward.kind === 'prize') return prizeById(reward.id) != null
  return false
}

async function giveRewards(accountId: string, def: SeasonDef, from: number, to: number, now: number) {
  for (const reward of def.rewards) {
    if (reward.level < from || reward.level > to || !rewardReady(reward)) continue
    if (reward.kind === 'tickets') {
      await awardTickets(accountId, 'season', `s${def.id}:lv${reward.level}`, reward.amount ?? 0, null, now)
    } else if (reward.kind === 'prize') {
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
  /** The rewards of every level reached since the last look. */
  reached: SeasonReward[]
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
  const level = levelFor(def, earned)
  const [last] = await db()
    .select({ earned: seasonProgress.earned, level: seasonProgress.level })
    .from(seasonProgress)
    .where(and(eq(seasonProgress.accountId, accountId), eq(seasonProgress.season, def.id)))
    .limit(1)
  const before = last?.earned ?? 0
  const lastLevel = last?.level ?? 0
  if (level > lastLevel || (catchUp && level > 0)) {
    await giveRewards(accountId, def, catchUp ? 1 : lastLevel + 1, level, now)
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
  const reached = def.rewards.filter((r) => r.level > lastLevel && r.level <= level)
  return { season, earned, before, level, reached }
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

export type SeasonYou = { earned: number; level: number; nextAt: number | null }

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
  const nextAt = nextLevelAt(def, sync.level)
  const next = def.rewards.find((r) => r.level === sync.level + 1)
  return {
    id: def.id,
    name: def.name,
    earned: sync.earned,
    added: Math.max(0, sync.earned - sync.before),
    level: sync.level,
    levels: def.levels,
    nextAt,
    next: next ? rewardView(next) : null,
    levelUp: sync.reached.map(rewardView),
  }
}
