import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { isBanned } from './bans.js'
import { db } from './db/client.js'
import { dailyHoleResults } from './db/schema.js'
import { huntDay } from './bugHunt.js'
import { namesOwnedByAccount, withAvatarIds } from './names.js'
import { updateCrossRunStreakRecords } from './records.js'
import { TRIES_SCORE_BASE } from './scoreLimits.js'
import { awardSecret, type SecretFound } from './secrets.js'
import { addScore, bestForName, type DeviceType } from './store.js'
import { payRun } from './tickets.js'

/*
 * Ace Chase's Today's Hole: a new hole every day, the same for everyone. The site builds the hole from the
 * date and plays it; a player's result is the tries their first bullseye took. This keeps each account's
 * result for the day, the first one sent, and tells anyone how the day is going: how many have got it,
 * in how many tries, and who got it in fewest.
 *
 * The tries are the site's word: nothing here can see the game. What's kept is one result a day an account,
 * sent that day (or just after midnight for one that was), so a result can't be improved on later.
 *
 * Today's Hole is all of Ace Chase, a daily like Hot Lap, so a day's result is also the account's run on
 * Ace Chase's board (the day's, as a daily's always is): under its tag, as the base less the tries, and
 * paid its tickets like any run. This is the only way onto that board.
 */

/** Today's Hole began here: no result is older. */
const FIRST_DAY = '2026-09-25'
/** A bullseye just before midnight, sent just after, still counts for its day. */
const MIDNIGHT_GRACE_MS = 30 * 60_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const PATTERN = /^[bioxl]{1,400}$/
/** The day's spread: one to nine tries, and ten or more. */
const SPREAD = 10
const TOP = 10

export type DailyEntry = { name: string; tries: number; at: number; avatarId?: string }

export type DailyReply = {
  day: string
  solved: number
  average: number | null
  spread: number[]
  top: DailyEntry[]
  you?: {
    tries: number | null
    place: number | null
    streak: number
    /** The tag today's result is under on Ace Chase's board; null until the account has one. */
    tag: string | null
    /** Today's result is on the board. */
    board: boolean
  }
  /** What today's result paid for the prize counter, as it went on the board. */
  tickets?: { earned: number; balance: number }
  /** A secret today's result found (secrets.ts): Hole in One. */
  secrets?: SecretFound[]
}

/** Who sent a result, for the board's own records of a run. */
export type ResultAudit = { ipHash?: string | null; userAgent?: string | null }

type ResultRow = typeof dailyHoleResults.$inferSelect

/* --------------------------------------------------------- the day --- */

const FRESH_MS = 20_000
let held: { day: string; at: number; reply: Omit<DailyReply, 'you'> } | null = null

/** How the day is going, for everyone. Asked on every page with the card, so held for a few seconds. */
async function dayReply(day: string, now: number): Promise<Omit<DailyReply, 'you'>> {
  if (held && held.day === day && now - held.at < FRESH_MS) return held.reply
  const buckets = await db()
    .select({ bucket: sql<number>`least(${dailyHoleResults.tries}, ${SPREAD})::int`, n: sql<number>`count(*)::int` })
    .from(dailyHoleResults)
    .where(eq(dailyHoleResults.day, day))
    .groupBy(sql`1`)
  const spread = Array.from({ length: SPREAD }, () => 0)
  let solved = 0
  for (const b of buckets) {
    spread[Math.max(1, Math.min(SPREAD, b.bucket)) - 1] += b.n
    solved += b.n
  }
  const [avg] = await db()
    .select({ avg: sql<number | null>`avg(${dailyHoleResults.tries})::float` })
    .from(dailyHoleResults)
    .where(eq(dailyHoleResults.day, day))
  const rows = await db()
    .select({ name: dailyHoleResults.name, tries: dailyHoleResults.tries, at: dailyHoleResults.solvedAt })
    .from(dailyHoleResults)
    .where(and(eq(dailyHoleResults.day, day), isNotNull(dailyHoleResults.name)))
    .orderBy(asc(dailyHoleResults.tries), asc(dailyHoleResults.solvedAt))
    .limit(TOP)
  const top = await withAvatarIds(rows.map((r) => ({ name: r.name!, tries: r.tries, at: r.at })))
  const reply = { day, solved, average: avg?.avg == null ? null : Math.round(avg.avg * 10) / 10, spread, top }
  held = { day, at: now, reply }
  return reply
}

/* --------------------------------------------------------- your day --- */

/** Where a result came in on its day: 1 for the fewest tries, the first to them winning a tie. */
async function placeOf(day: string, tries: number, at: number): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(dailyHoleResults)
    .where(
      and(
        eq(dailyHoleResults.day, day),
        sql`(${dailyHoleResults.tries} < ${tries} or (${dailyHoleResults.tries} = ${tries} and ${dailyHoleResults.solvedAt} < ${at}))`,
      ),
    )
  return (row?.n ?? 0) + 1
}

function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10)
}

/** Days in a row with a result: counting today if there is one, or up to yesterday while there isn't. */
async function streakOf(accountId: string, today: string): Promise<number> {
  const rows = await db()
    .select({ day: dailyHoleResults.day })
    .from(dailyHoleResults)
    .where(eq(dailyHoleResults.accountId, accountId))
    .orderBy(desc(dailyHoleResults.day))
    .limit(400)
  const days = new Set(rows.map((r) => r.day))
  let d = days.has(today) ? today : previousDay(today)
  let n = 0
  while (days.has(d)) {
    n++
    d = previousDay(d)
  }
  return n
}

/** Today, for anyone; signed in, with where your result came in and your streak. */
export async function dailyReply(accountId: string | null, now = Date.now()): Promise<DailyReply> {
  const day = huntDay(now)
  const reply = await dayReply(day, now)
  if (!accountId) return reply
  const [mine] = await db()
    .select()
    .from(dailyHoleResults)
    .where(and(eq(dailyHoleResults.accountId, accountId), eq(dailyHoleResults.day, day)))
  const caught = mine ? await catchUp(accountId, mine, now) : { tag: null, board: false }
  return {
    ...(caught.tickets ? await dayReply(day, now) : reply),
    you: {
      tries: mine?.tries ?? null,
      place: mine ? await placeOf(day, mine.tries, mine.solvedAt) : null,
      streak: await streakOf(accountId, day),
      tag: caught.tag,
      board: caught.board,
    },
    ...(caught.tickets ? { tickets: caught.tickets } : {}),
  }
}

/** A result the site sent, if it could be one: today (or yesterday, just after midnight), a real count of tries. */
export function validResult(input: { day: string; tries: number; pattern: string }, now = Date.now()): boolean {
  if (!DAY.test(input.day) || input.day < FIRST_DAY) return false
  const onItsDay = input.day === huntDay(now) || input.day === huntDay(now - MIDNIGHT_GRACE_MS)
  if (!onItsDay) return false
  if (!Number.isInteger(input.tries) || input.tries < 1 || input.tries > 400) return false
  // One letter a try, the last of them the bullseye and the only one: the first bullseye ends the day.
  return PATTERN.test(input.pattern) && input.pattern.length === input.tries && input.pattern.indexOf('b') === input.tries - 1
}

/**
 * A day's result as the account's run on Ace Chase's board, and its tickets. Only today's: one sent just
 * after midnight belongs to yesterday's hole, and the board would stamp it today. A banned tag stays off.
 */
async function onTheBoard(
  accountId: string,
  name: string,
  tries: number,
  device: DeviceType,
  audit: ResultAudit,
  now: number,
): Promise<{ boarded: boolean; tickets?: DailyReply['tickets'] }> {
  if (await isBanned(name, accountId)) return { boarded: false }
  const score = TRIES_SCORE_BASE - tries
  const result = await addScore('acechase', name, score, device, {
    runId: null,
    durationMs: null,
    ipHash: audit.ipHash ?? null,
    userAgent: audit.userAgent ?? null,
  })
  await updateCrossRunStreakRecords('acechase', name, score, device, now).catch((err: unknown) => {
    console.warn(`[daily-hole] streak records for ${name}:`, err)
  })
  // One result a day, so never a best to beat: the first ever is paid as a first go, once.
  const paid = await payRun({
    accountId,
    game: 'acechase',
    runId: `hole-${huntDay(now)}`,
    entry: result.entry,
    score,
    priorBest: null,
    pickups: 0,
    now,
  }).catch((err: unknown) => {
    console.warn(`[tickets] acechase hole for ${name}:`, err)
    return null
  })
  return { boarded: true, tickets: paid ? { earned: paid.earned, balance: paid.balance } : undefined }
}

/** Two reads at once can't both put the same result on the board. */
const boarding = new Set<string>()

/**
 * Today's result, onto the board if it isn't there yet: one kept before its account had a tag (the tag
 * is the name it goes on the board under), or before results went on the board at all. Asked on every
 * read of the day, so a tag made after the bullseye still puts it there. An Ace Chase run on the board
 * today from before, a round of the old three holes, isn't this result, so it doesn't count.
 */
async function catchUp(
  accountId: string,
  mine: ResultRow,
  now: number,
): Promise<{ tag: string | null; board: boolean; tickets?: DailyReply['tickets'] }> {
  let tag = mine.name
  if (!tag) {
    const [owned] = await namesOwnedByAccount(accountId)
    if (!owned) return { tag: null, board: false }
    await db()
      .update(dailyHoleResults)
      .set({ name: owned.name })
      .where(and(eq(dailyHoleResults.accountId, accountId), eq(dailyHoleResults.day, mine.day), isNull(dailyHoleResults.name)))
    // Named, it's in the day's top ten.
    held = null
    tag = owned.name
  }
  const best = await bestForName('acechase', tag, 'daily', now)
  if (best && best.score > TRIES_SCORE_BASE - 1000) return { tag, board: true }
  const key = `${accountId}:${mine.day}`
  if (boarding.has(key)) return { tag, board: false }
  boarding.add(key)
  try {
    const { boarded, tickets } = await onTheBoard(accountId, tag, mine.tries, 'desktop', {}, now)
    return { tag, board: boarded, tickets }
  } finally {
    boarding.delete(key)
  }
}

/** Keep a day's result: the first one an account sends for a day stands, and today's goes on the board. */
export async function recordResult(
  accountId: string,
  input: { day: string; tries: number; pattern: string; device?: DeviceType },
  audit: ResultAudit = {},
  now = Date.now(),
): Promise<DailyReply> {
  let tickets: DailyReply['tickets']
  let secrets: SecretFound[] = []
  if (validResult(input, now)) {
    const [tag] = await namesOwnedByAccount(accountId)
    const added = await db()
      .insert(dailyHoleResults)
      .values({ accountId, day: input.day, tries: input.tries, pattern: input.pattern, name: tag?.name ?? null, solvedAt: now })
      .onConflictDoNothing()
      .returning({ day: dailyHoleResults.day })
    // A new result today changes what everyone sees.
    if (added.length) {
      held = null
      if (tag && input.day === huntDay(now)) {
        tickets = (await onTheBoard(accountId, tag.name, input.tries, input.device ?? 'desktop', audit, now)).tickets
        if (input.tries === 1) {
          const found = await awardSecret({ accountId, name: tag.name, key: 'holeinone', at: now }).catch(() => null)
          if (found) secrets = [found]
        }
      }
    }
  }
  const reply = await dailyReply(accountId, now)
  return { ...reply, ...(tickets ? { tickets } : {}), ...(secrets.length ? { secrets } : {}) }
}
