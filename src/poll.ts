import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, ticketLedger, type TicketDetail } from './db/schema.js'
import { POLL_FIRST_DAY, POLLS, type PlannedPoll } from './pollPlan.js'
import { boardDateKey } from './store.js'
import { awardTickets } from './tickets.js'

/*
 * Blip's question of the day (Ramsey, 2026-10-09: "maybe he can even come out daily and do a daily poll with a
 * question about random things"). One question a day on the boards' clock, planned ahead (pollPlan.ts) and
 * editable for its day on /admin (kept in app_meta as `poll:<n>`). Only a signed-in player answers ("if
 * non-signed in players can vote, doesn't that mean they could just keep voting?"), once a day, for a few
 * tickets: the answer is that ticket row (reason 'poll', ref `poll:<n>`, its pick in the detail), so the
 * ledger's one-row-per-reason-and-ref keeps it to one each, and the counts are its rows. Off the streak.
 */

/** What answering Blip's question pays. */
export const POLL_TICKETS = 5

export type Poll = { n: number; day: string; q: string; options: string[]; edited: boolean }

/** A question's answers so far: how many picked each option, and in all. */
export type PollCounts = { counts: number[]; total: number }

const FIRST_KEY = Number(POLL_FIRST_DAY.replace(/-/g, ''))

function keyDate(key: number): Date {
  return new Date(Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100))
}

/** A day's question's number: #1 on the first day; null for a day before it. */
export function pollNumber(dayKey: number): number | null {
  const n = Math.round((keyDate(dayKey).getTime() - keyDate(FIRST_KEY).getTime()) / 86_400_000) + 1
  return n >= 1 ? n : null
}

/** The board day of question #n. */
export function pollDay(n: number): string {
  const d = keyDate(FIRST_KEY)
  d.setUTCDate(d.getUTCDate() + n - 1)
  return d.toISOString().slice(0, 10)
}

const metaKey = (n: number) => `poll:${n}`
const ref = (n: number) => `poll:${n}`

function planned(n: number): PlannedPoll {
  return POLLS[(n - 1) % POLLS.length]!
}

/** A question as edited on /admin, if it was. */
function parseEdit(value: string | undefined): PlannedPoll | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as { q?: unknown; options?: unknown }
    if (typeof v.q !== 'string' || !Array.isArray(v.options) || !v.options.every((o) => typeof o === 'string')) return null
    return { q: v.q, options: v.options as string[] }
  } catch {
    return null
  }
}

/** Questions #from to #to, each as planned or as edited. */
export async function pollsBetween(from: number, to: number): Promise<Poll[]> {
  const ns = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
  if (!ns.length) return []
  const rows = await db()
    .select({ key: appMeta.key, value: appMeta.value })
    .from(appMeta)
    .where(inArray(appMeta.key, ns.map(metaKey)))
  const edits = new Map(rows.map((r) => [r.key, parseEdit(r.value)]))
  return ns.map((n) => {
    const edit = edits.get(metaKey(n)) ?? null
    const p = edit ?? planned(n)
    return { n, day: pollDay(n), q: p.q, options: [...p.options], edited: edit != null }
  })
}

async function pollAt(n: number): Promise<Poll> {
  return (await pollsBetween(n, n))[0]!
}

/** Edit question #n for its day. */
export async function editPoll(n: number, q: string, options: string[]): Promise<Poll> {
  const value = JSON.stringify({ q, options })
  await db().insert(appMeta).values({ key: metaKey(n), value }).onConflictDoUpdate({ target: appMeta.key, set: { value } })
  counted.delete(n)
  return pollAt(n)
}

/** Put question #n back to the plan's. */
export async function resetPoll(n: number): Promise<Poll> {
  await db().delete(appMeta).where(eq(appMeta.key, metaKey(n)))
  counted.delete(n)
  return pollAt(n)
}

/** Counts a short while old, so a busy morning doesn't count every row on every look. */
const counted = new Map<number, { at: number; value: PollCounts }>()
const COUNT_FOR_MS = 15_000

async function countsFor(n: number, options: number, now: number): Promise<PollCounts> {
  const kept = counted.get(n)
  if (kept && now - kept.at < COUNT_FOR_MS && kept.value.counts.length === options) return kept.value
  const rows = await db()
    .select({ pick: sql<string>`${ticketLedger.detail}->>'pick'`, votes: sql<number>`count(*)::int` })
    .from(ticketLedger)
    .where(and(eq(ticketLedger.reason, 'poll'), eq(ticketLedger.ref, ref(n))))
    .groupBy(sql`${ticketLedger.detail}->>'pick'`)
  const counts = Array.from({ length: options }, () => 0)
  for (const row of rows) {
    const pick = Number(row.pick)
    if (Number.isInteger(pick) && pick >= 0 && pick < options) counts[pick]! += Number(row.votes)
  }
  const value = { counts, total: counts.reduce((a, b) => a + b, 0) }
  counted.set(n, { at: now, value })
  if (counted.size > 64) counted.delete(counted.keys().next().value!)
  return value
}

async function pickOf(accountId: string, n: number): Promise<number | null> {
  const [row] = await db()
    .select({ detail: ticketLedger.detail })
    .from(ticketLedger)
    .where(and(eq(ticketLedger.accountId, accountId), eq(ticketLedger.reason, 'poll'), eq(ticketLedger.ref, ref(n))))
    .limit(1)
  const pick = (row?.detail as { pick?: unknown } | null | undefined)?.pick
  return typeof pick === 'number' ? pick : null
}

export type PollView = {
  today: (Poll & { pick: number | null } & Partial<PollCounts>) | null
  yesterday: (Poll & PollCounts) | null
  /** Tomorrow's question, as a tease. */
  tomorrow: string | null
  tickets: number
}

/** Blip's question for a player (or a visitor, `null`): today's, its counts once they've answered, yesterday's result. */
export async function pollView(accountId: string | null, now = Date.now()): Promise<PollView> {
  const key = boardDateKey(now)
  const n = pollNumber(key)
  if (n == null) return { today: null, yesterday: null, tomorrow: null, tickets: POLL_TICKETS }
  const around = await pollsBetween(Math.max(1, n - 1), n + 1)
  const poll = around.find((p) => p.n === n)!
  const before = around.find((p) => p.n === n - 1) ?? null
  const after = around.find((p) => p.n === n + 1) ?? null
  const pick = accountId ? await pickOf(accountId, n) : null
  const today = pick == null ? { ...poll, pick } : { ...poll, pick, ...(await countsFor(n, poll.options.length, now)) }
  const yesterday = before ? { ...before, ...(await countsFor(before.n, before.options.length, now)) } : null
  return { today, yesterday, tomorrow: after?.q ?? null, tickets: POLL_TICKETS }
}

/** Answer today's question: once a day, for POLL_TICKETS. */
export async function answerPoll(accountId: string, pick: number, now = Date.now()): Promise<PollView & { earned: number }> {
  const n = pollNumber(boardDateKey(now))
  if (n == null) throw Object.assign(new Error('There’s no question today'), { status: 404, code: 'NO_POLL' })
  const poll = await pollAt(n)
  if (!Number.isInteger(pick) || pick < 0 || pick >= poll.options.length) {
    throw Object.assign(new Error('That isn’t one of the answers'), { status: 400, code: 'BAD_PICK' })
  }
  const detail: TicketDetail = { pick, label: poll.q }
  const { earned } = await awardTickets(accountId, 'poll', ref(n), POLL_TICKETS, null, now, detail)
  counted.delete(n)
  return { ...(await pollView(accountId, now)), earned }
}
