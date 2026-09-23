import { desc, eq, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { getClaim } from './names.js'
import { notify } from './notifications.js'
import { nameClaims, trophyAwards, trophyCursor } from './db/schema.js'
import {
  globalRanksForClosedPeriod,
  invalidateHistoryCache,
  monthKey,
  weekStartKey,
} from './store.js'

export type TrophyPeriod = 'weekly' | 'monthly' | 'event'
export const MAX_TROPHY_RANK = 10

export type TrophyAward = {
  id: string
  period: TrophyPeriod
  periodKey: number
  name: string
  rank: number
  score: number
  games: number
  accountId?: string
  /** Set when the trophy came from winning an event rather than a board. */
  eventId?: string
  eventTitle?: string
  awardedAt: number
}

function awardId(period: TrophyPeriod, periodKey: number, name: string) {
  return `${period}-${periodKey}-${name}`
}

function rowToAward(row: typeof trophyAwards.$inferSelect): TrophyAward {
  return {
    id: row.id,
    period: row.period as TrophyPeriod,
    periodKey: row.periodKey,
    name: row.name,
    rank: row.rank,
    score: row.score,
    games: row.games,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.eventId ? { eventId: row.eventId } : {}),
    ...(row.eventTitle ? { eventTitle: row.eventTitle } : {}),
    awardedAt: row.awardedAt,
  }
}

async function lookupAccountId(name: string): Promise<string | undefined> {
  const rows = await db()
    .select({ accountId: nameClaims.accountId })
    .from(nameClaims)
    .where(eq(nameClaims.name, name))
    .limit(1)
  return rows[0]?.accountId ?? undefined
}

async function getCursor() {
  const rows = await db().select().from(trophyCursor).where(eq(trophyCursor.id, 'default')).limit(1)
  if (rows[0]) {
    return {
      weeklyInitialized: rows[0].weeklyInitialized,
      monthlyInitialized: rows[0].monthlyInitialized,
    }
  }
  await db().insert(trophyCursor).values({ id: 'default' }).onConflictDoNothing()
  return { weeklyInitialized: false, monthlyInitialized: false }
}

async function setCursor(next: { weeklyInitialized: boolean; monthlyInitialized: boolean }) {
  await db()
    .insert(trophyCursor)
    .values({
      id: 'default',
      weeklyInitialized: next.weeklyInitialized,
      monthlyInitialized: next.monthlyInitialized,
    })
    .onConflictDoUpdate({
      target: trophyCursor.id,
      set: {
        weeklyInitialized: next.weeklyInitialized,
        monthlyInitialized: next.monthlyInitialized,
      },
    })
}

/** Board trophies only — event wins are awarded directly, not by period. */
async function awardClosedPeriod(
  period: Exclude<TrophyPeriod, 'event'>,
  periodKey: number,
  now: number,
): Promise<boolean> {
  const ranked = (await globalRanksForClosedPeriod(period, periodKey)).slice(0, MAX_TROPHY_RANK)
  if (ranked.length === 0) return false
  // One lookup for the whole period rather than one per award.
  const ids = ranked.map((row) => awardId(period, periodKey, row.name))
  const existing = new Set(
    (
      await db()
        .select({ id: trophyAwards.id })
        .from(trophyAwards)
        .where(inArray(trophyAwards.id, ids))
    ).map((r) => r.id),
  )
  let changed = false
  for (const row of ranked) {
    const id = awardId(period, periodKey, row.name)
    if (existing.has(id)) continue
    const accountId = await lookupAccountId(row.name)
    await db().insert(trophyAwards).values({
      id,
      period,
      periodKey,
      name: row.name,
      rank: row.rank,
      score: row.score,
      games: row.games,
      accountId: accountId ?? null,
      awardedAt: now,
    })
    changed = true
  }
  return changed
}

function addDaysToDateKey(key: number, days: number) {
  const y = Math.floor(key / 10_000)
  const m = Math.floor((key % 10_000) / 100)
  const d = key % 100
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return y * 10_000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate()
}

function previousWeekStart(now: number) {
  return addDaysToDateKey(weekStartKey(now), -7)
}

function previousMonthKey(now: number) {
  const mk = monthKey(now)
  const y = Math.floor(mk / 100)
  const m = mk % 100
  if (m === 1) return (y - 1) * 100 + 12
  return y * 100 + (m - 1)
}

function listWeekKeysBefore(now: number, count: number) {
  const keys: number[] = []
  let key = previousWeekStart(now)
  for (let i = 0; i < count; i++) {
    keys.push(key)
    key = addDaysToDateKey(key, -7)
  }
  return keys
}

function listMonthKeysBefore(now: number, count: number) {
  const keys: number[] = []
  let key = previousMonthKey(now)
  for (let i = 0; i < count; i++) {
    keys.push(key)
    const y = Math.floor(key / 100)
    const m = key % 100
    if (m === 1) key = (y - 1) * 100 + 12
    else key = y * 100 + (m - 1)
  }
  return keys
}

/*
 * The rollover only has work to do once a week and once a month, but it ran
 * in full on every trophies request — a rank computation for the last week
 * and month plus an existence check per award — which is what made a
 * profile take six seconds to open. Run it at most every few minutes per
 * process, and share one run between requests that arrive together.
 */
const ENSURE_EVERY_MS = 5 * 60_000
let lastEnsuredAt = 0
let ensuring: Promise<void> | null = null

/** Award global-rank trophies for completed weekly/monthly periods (lazy rollover). */
export async function ensurePeriodTrophies(now = Date.now()) {
  if (now - lastEnsuredAt < ENSURE_EVERY_MS) return
  // Only the first pass of a process holds the request. Later ones run
  // behind it: a week rolling over can land a moment late, but nobody waits
  // a second on their profile for it.
  if (ensuring) return lastEnsuredAt ? undefined : ensuring
  ensuring = (async () => {
    // Rank from the tables as they stand. The board cache can be minutes
    // behind a script that rewrote them (a prune, a wipe, a reseed), and an
    // award made from a stale board stays on someone's shelf for good.
    invalidateHistoryCache()
    const cursor = await getCursor()
    const weekCount = cursor.weeklyInitialized ? 1 : 8
    const monthCount = cursor.monthlyInitialized ? 1 : 6

    for (const weekKey of listWeekKeysBefore(now, weekCount)) {
      await awardClosedPeriod('weekly', weekKey, now)
    }

    for (const monthKeyVal of listMonthKeysBefore(now, monthCount)) {
      await awardClosedPeriod('monthly', monthKeyVal, now)
    }

    await setCursor({ weeklyInitialized: true, monthlyInitialized: true })
    // Showcase trophies are sample data for `npm run seed`, not something every
    // rollover should put back: they name weeks nobody played.
    lastEnsuredAt = Date.now()
  })().finally(() => {
    ensuring = null
  })
  if (lastEnsuredAt) {
    ensuring.catch(() => {})
    return
  }
  return ensuring
}

export async function trophiesForName(name: string): Promise<TrophyAward[]> {
  const cleaned = name.trim().slice(0, 12).toUpperCase()
  if (!cleaned) return []
  const rows = await db()
    .select()
    .from(trophyAwards)
    .where(eq(trophyAwards.name, cleaned))
    .orderBy(desc(trophyAwards.awardedAt), trophyAwards.rank)
  return rows.map(rowToAward)
}

export async function recentTrophies(limit = 20): Promise<TrophyAward[]> {
  const capped = Math.min(50, Math.max(1, Math.floor(limit)) || 20)
  const rows = await db()
    .select()
    .from(trophyAwards)
    .orderBy(desc(trophyAwards.awardedAt), trophyAwards.rank)
    .limit(capped)
  return rows.map(rowToAward)
}

export async function renamePlayerAcrossTrophies(from: string, to: string) {
  const rows = await db().select().from(trophyAwards).where(eq(trophyAwards.name, from))
  let updated = 0
  for (const award of rows) {
    const newId = awardId(award.period as TrophyPeriod, award.periodKey, to)
    await db().delete(trophyAwards).where(eq(trophyAwards.id, award.id))
    await db()
      .insert(trophyAwards)
      .values({
        ...award,
        id: newId,
        name: to,
      })
      .onConflictDoNothing()
    updated++
  }
  return updated
}

export type TrophySummary = {
  total: number
  podium: number
  topTen: number
  /** Events won, counted separately from the rolling board trophies. */
  events: number
}

/**
 * Record an event win.
 *
 * Winning a bracket or a scores event left no trace anywhere once the page was
 * closed — the celebration fired once and that was it. These sit alongside the
 * weekly and monthly board trophies, tagged with the event so they can name it.
 */
export async function awardEventWin(opts: {
  eventId: string
  eventTitle: string
  periodKey: number
  name: string
  score: number
  games: number
  accountId?: string | null
  awardedAt?: number
}): Promise<boolean> {
  const name = opts.name.trim().slice(0, 12).toUpperCase()
  if (!name) return false
  const result = await db()
    .insert(trophyAwards)
    .values({
      id: `event-${opts.eventId}-${name}`,
      period: 'event',
      periodKey: opts.periodKey,
      name,
      rank: 1,
      score: Math.max(0, Math.floor(opts.score)),
      games: Math.max(0, Math.floor(opts.games)),
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      eventId: opts.eventId,
      eventTitle: opts.eventTitle.slice(0, 60),
      awardedAt: opts.awardedAt ?? Date.now(),
    })
    .onConflictDoNothing()
    .returning({ id: trophyAwards.id })
  // Only on a genuinely new award — the insert is a no-op on replay.
  if (result.length > 0) await notifyEventWin(name, opts.eventTitle, opts.eventId)
  return result.length > 0
}

/**
 * Congratulate the winner in the inbox.
 *
 * Inbox only. Winning is good news that keeps, and the player almost always
 * just watched it happen on the bracket page anyway.
 */
async function notifyEventWin(name: string, eventTitle: string, eventId: string) {
  try {
    const claim = await getClaim(name)
    if (!claim?.accountId) return
    await notify({
      accountId: claim.accountId,
      kind: 'trophy',
      title: `You won ${eventTitle}`,
      body: 'A trophy has been added to your case.',
      href: '#/rank',
      digestKey: `trophy:${eventId}`,
    })
  } catch {
    // The trophy is already recorded; the note about it is a nicety.
  }
}

export type TrophyCount = Pick<TrophySummary, 'total' | 'podium'>

function summarizeAwards(awards: TrophyAward[]): TrophySummary {
  let podium = 0
  let topTen = 0
  let events = 0
  for (const award of awards) {
    if (award.period === 'event') events++
    else if (award.rank <= 3) podium++
    else topTen++
  }
  return { total: awards.length, podium, topTen, events }
}

export async function trophySummaryForName(name: string): Promise<TrophySummary> {
  return summarizeAwards(await trophiesForName(name))
}

export async function trophySummariesForNames(
  names: string[],
): Promise<Record<string, TrophyCount>> {
  const wanted = names.map((n) => n.trim().slice(0, 12).toUpperCase()).filter(Boolean)
  const out: Record<string, TrophyCount> = {}
  if (!wanted.length) return out
  const rows = await db()
    .select()
    .from(trophyAwards)
    .where(inArray(trophyAwards.name, wanted))
  for (const award of rows) {
    const row = out[award.name] ?? { total: 0, podium: 0 }
    row.total++
    if (award.period !== 'event' && award.rank <= 3) row.podium++
    out[award.name] = row
  }
  return out
}

type ShowcaseAward = Omit<TrophyAward, 'id' | 'accountId' | 'name'> & { name: string }

const SHOWCASE_AWARDS: ShowcaseAward[] = [
  {
    period: 'weekly',
    periodKey: 20260825,
    name: 'JEFF',
    rank: 1,
    score: 842,
    games: 7,
    awardedAt: Date.UTC(2026, 7, 31, 12, 0, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260818,
    name: 'JEFF',
    rank: 2,
    score: 791,
    games: 6,
    awardedAt: Date.UTC(2026, 7, 24, 12, 0, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260811,
    name: 'JEFF',
    rank: 7,
    score: 612,
    games: 5,
    awardedAt: Date.UTC(2026, 7, 17, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202608,
    name: 'JEFF',
    rank: 1,
    score: 2140,
    games: 8,
    awardedAt: Date.UTC(2026, 8, 1, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202607,
    name: 'JEFF',
    rank: 3,
    score: 1884,
    games: 8,
    awardedAt: Date.UTC(2026, 7, 1, 12, 0, 0),
  },
  {
    period: 'monthly',
    periodKey: 202606,
    name: 'JEFF',
    rank: 8,
    score: 1340,
    games: 6,
    awardedAt: Date.UTC(2026, 6, 1, 12, 0, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260825,
    name: 'MOBILE',
    rank: 1,
    score: 910,
    games: 8,
    awardedAt: Date.UTC(2026, 7, 31, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260818,
    name: 'MOBILE',
    rank: 3,
    score: 744,
    games: 6,
    awardedAt: Date.UTC(2026, 7, 24, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260811,
    name: 'MOBILE',
    rank: 2,
    score: 802,
    games: 7,
    awardedAt: Date.UTC(2026, 7, 17, 12, 5, 0),
  },
  {
    period: 'weekly',
    periodKey: 20260804,
    name: 'MOBILE',
    rank: 5,
    score: 680,
    games: 5,
    awardedAt: Date.UTC(2026, 7, 10, 12, 5, 0),
  },
  {
    period: 'monthly',
    periodKey: 202608,
    name: 'MOBILE',
    rank: 2,
    score: 2010,
    games: 8,
    awardedAt: Date.UTC(2026, 8, 1, 12, 5, 0),
  },
]

/** Idempotent: fills showcase profiles with weekly/monthly podium + honor ribbons. */
export async function ensureShowcaseTrophies() {
  let changed = false
  const ids = SHOWCASE_AWARDS.map((row) => awardId(row.period, row.periodKey, row.name))
  const present = new Set(
    (
      await db()
        .select({ id: trophyAwards.id })
        .from(trophyAwards)
        .where(inArray(trophyAwards.id, ids))
    ).map((r) => r.id),
  )
  for (const row of SHOWCASE_AWARDS) {
    const id = awardId(row.period, row.periodKey, row.name)
    if (present.has(id)) continue
    const accountId = await lookupAccountId(row.name)
    await db().insert(trophyAwards).values({
      ...row,
      id,
      accountId: accountId ?? null,
    })
    changed = true
  }
  return changed
}

export async function clearAllTrophies() {
  await db().delete(trophyAwards)
  await setCursor({ weeklyInitialized: false, monthlyInitialized: false })
}
