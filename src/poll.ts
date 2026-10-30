import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, prizesOwned, ticketLedger, type TicketDetail } from './db/schema.js'
import { POLL_FIRST_DAY, POLLS, type PlannedPoll } from './pollPlan.js'
import { BLIP_SKIN_EVERY, BLIP_SKINS } from './skins.js'
import { boardDateKey } from './store.js'
import { awardTickets } from './tickets.js'

/*
 * Blip's question of the day (Ramsey, 2026-10-09: "maybe he can even come out daily and do a daily poll with a
 * question about random things"). One question a day on the boards' clock, planned ahead (pollPlan.ts) and changed
 * on /admin: edited, moved to another day or taken out (2026-10-30: "can you add ability to reorder questions and
 * delete them in admin?"), which the queue below keeps. Only a signed-in player answers ("if
 * non-signed in players can vote, doesn't that mean they could just keep voting?"), once a day, for a few
 * tickets: the answer is that ticket row (reason 'poll', ref `poll:<n>`, its pick in the detail), so the
 * ledger's one-row-per-reason-and-ref keeps it to one each, and the counts are its rows. Off the streak.
 * Every BLIP_SKIN_EVERY answers, ever, win the next skin of Blip's set (skins.ts BLIP_SKINS), owned like a prize.
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

/** A question to come, in /admin's order: `was` is how the plan had it before it was edited there, to go back to. */
type QueueItem = PlannedPoll & { was?: PlannedPoll }

/**
 * Blip's questions in the order /admin left them: day #from takes the first, each day after it the next, and round
 * again from the top once they run out. It's made the first time a question is edited, moved or taken out, from the
 * plan as it stood from that day on. Each change starts it again from that day, and keeps the days it covered before
 * as they were asked (app_meta `poll:<n>`, `kept`), since their answers are in and go by the day's number.
 */
type Queue = { from: number; items: QueueItem[] }

const QUEUE_KEY = 'poll_queue'

function asPoll(value: unknown): PlannedPoll | null {
  const v = value as { q?: unknown; options?: unknown } | null | undefined
  if (!v || typeof v.q !== 'string' || !Array.isArray(v.options) || !v.options.every((o) => typeof o === 'string')) return null
  return { q: v.q, options: v.options as string[] }
}

/**
 * A day's own question in app_meta: edited on /admin before the queue began, or kept as it was asked once the queue
 * moved on from it (`kept`, with whether it had been edited).
 */
function parseEdit(value: string | undefined): (PlannedPoll & { edited: boolean }) | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as { kept?: unknown; edited?: unknown }
    const poll = asPoll(v)
    return poll && { ...poll, edited: v.kept === true ? v.edited === true : true }
  } catch {
    return null
  }
}

function parseQueue(value: string | undefined): Queue | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as { from?: unknown; items?: unknown }
    if (typeof v.from !== 'number' || !Number.isInteger(v.from) || v.from < 1 || !Array.isArray(v.items) || !v.items.length) return null
    const items: QueueItem[] = []
    for (const raw of v.items as unknown[]) {
      const poll = asPoll(raw)
      if (!poll) return null
      const was = asPoll((raw as { was?: unknown }).was)
      items.push(was ? { ...poll, was } : poll)
    }
    return { from: v.from, items }
  } catch {
    return null
  }
}

/** Day #n's question in the queue, for a day from its first on. */
function queued(queue: Queue, n: number): QueueItem {
  const len = queue.items.length
  return queue.items[(((n - queue.from) % len) + len) % len]!
}

/** Questions #from to #to, each as planned, as /admin changed it, or as it was asked. */
export async function pollsBetween(from: number, to: number): Promise<Poll[]> {
  const ns = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
  if (!ns.length) return []
  const rows = await db()
    .select({ key: appMeta.key, value: appMeta.value })
    .from(appMeta)
    .where(inArray(appMeta.key, [QUEUE_KEY, ...ns.map(metaKey)]))
  const queue = parseQueue(rows.find((r) => r.key === QUEUE_KEY)?.value)
  const edits = new Map(rows.map((r) => [r.key, parseEdit(r.value)]))
  return ns.map((n) => {
    if (queue && n >= queue.from) {
      const item = queued(queue, n)
      return { n, day: pollDay(n), q: item.q, options: [...item.options], edited: item.was != null }
    }
    const edit = edits.get(metaKey(n)) ?? null
    const p = edit ?? planned(n)
    return { n, day: pollDay(n), q: p.q, options: [...p.options], edited: edit?.edited ?? false }
  })
}

async function pollAt(n: number): Promise<Poll> {
  return (await pollsBetween(n, n))[0]!
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]

function refusal(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

/**
 * The questions from today on, today's first, for a change on /admin: the queue started again from today, with the
 * days it covered before today kept as they were asked; or, before there's a queue, a round of the plan from today,
 * where a day edited here takes its edit along (the queue has it now, so its own row goes). Holds the queue's row
 * until the change is written, so two changes at once take turns.
 */
async function queueFromToday(tx: Tx, today: number): Promise<QueueItem[]> {
  // An upsert that changes nothing still locks the row it meets, and returns it as the last change left it.
  const [row] = await tx
    .insert(appMeta)
    .values({ key: QUEUE_KEY, value: '' })
    .onConflictDoUpdate({ target: appMeta.key, set: { key: sql`excluded.key` } })
    .returning({ value: appMeta.value })
  const queue = parseQueue(row?.value)
  if (queue) {
    const kept = []
    for (let n = queue.from; n < today; n++) {
      const { q, options, was } = queued(queue, n)
      kept.push({ key: metaKey(n), value: JSON.stringify({ q, options, kept: true, edited: was != null }) })
    }
    if (kept.length) {
      await tx.insert(appMeta).values(kept).onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` } })
    }
    const len = queue.items.length
    const k = (((today - queue.from) % len) + len) % len
    return [...queue.items.slice(k), ...queue.items.slice(0, k)]
  }
  const ns = Array.from({ length: POLLS.length }, (_, i) => today + i)
  const rows = await tx
    .select({ key: appMeta.key, value: appMeta.value })
    .from(appMeta)
    .where(inArray(appMeta.key, ns.map(metaKey)))
  if (rows.length) await tx.delete(appMeta).where(inArray(appMeta.key, rows.map((r) => r.key)))
  const edits = new Map(rows.map((r) => [r.key, parseEdit(r.value)]))
  return ns.map((n) => {
    const plan = planned(n)
    const edit = edits.get(metaKey(n))
    return edit ? { q: edit.q, options: edit.options, was: plan } : { q: plan.q, options: [...plan.options] }
  })
}

/** A change to the questions from today on (today's at 0), written as the queue from today. */
async function changeQueue(now: number, change: (items: QueueItem[], today: number) => void): Promise<void> {
  const today = pollNumber(boardDateKey(now))
  if (today == null) throw refusal('Blip’s questions haven’t started yet', 409, 'NO_POLL')
  await db().transaction(async (tx) => {
    const items = await queueFromToday(tx, today)
    change(items, today)
    await tx.update(appMeta).set({ value: JSON.stringify({ from: today, items }) }).where(eq(appMeta.key, QUEUE_KEY))
  })
  counted.clear()
}

/** Day #n's place in the questions from today on: never a past day (its answers are in), nor past a round. */
function placeOf(n: number, today: number, items: QueueItem[]): number {
  if (n < today) throw refusal('That day’s gone: its answers are in', 409, 'PAST_POLL')
  if (n - today >= items.length) throw refusal('That day is a question come round again', 409, 'NO_POLL')
  return n - today
}

function samePoll(a: PlannedPoll, b: PlannedPoll): boolean {
  return a.q === b.q && a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i])
}

/** Edit day #n's question: today's or one to come, never a past one (its answers are in). */
export async function editPoll(n: number, q: string, options: string[], now = Date.now()): Promise<Poll> {
  await changeQueue(now, (items, today) => {
    const i = placeOf(n, today, items)
    const item = items[i]!
    const was = item.was ?? { q: item.q, options: item.options }
    items[i] = samePoll(was, { q, options }) ? { q, options } : { q, options, was }
  })
  return pollAt(n)
}

/** Put day #n's question back to how the plan had it, before it was edited here. */
export async function resetPoll(n: number, now = Date.now()): Promise<Poll> {
  await changeQueue(now, (items, today) => {
    const i = placeOf(n, today, items)
    const was = items[i]!.was
    if (was) items[i] = { q: was.q, options: [...was.options] }
  })
  return pollAt(n)
}

/**
 * Move day #n's question a day sooner (`by` -1) or later (1), swapping with that day's: a question to come, never
 * today's, whose answers may be in, nor into its place.
 */
export async function movePoll(n: number, by: -1 | 1, now = Date.now()): Promise<void> {
  await changeQueue(now, (items, today) => {
    const i = placeOf(n, today, items)
    const j = i + by
    if (i === 0 || j === 0) throw refusal('Today’s question stays where it is: its answers may be in', 409, 'TODAY_POLL')
    if (j >= items.length) throw refusal('That’s the last question before they come round again', 409, 'LAST_POLL')
    const moving = items[i]!
    items[i] = items[j]!
    items[j] = moving
  })
}

/** Take day #n's question out: Blip doesn't ask it again, and each question after it comes a day sooner. */
export async function removePoll(n: number, now = Date.now()): Promise<void> {
  await changeQueue(now, (items, today) => {
    const i = placeOf(n, today, items)
    if (i === 0) throw refusal('Today’s question stays: its answers may be in', 409, 'TODAY_POLL')
    if (items.length <= 2) throw refusal('Blip needs a question for tomorrow too', 409, 'LAST_POLL')
    items.splice(i, 1)
  })
}

/** Blip's questions from day #from (today's, by default) for /admin, and how many there are before they come round. */
export async function adminPolls(from: number | null, count: number, now = Date.now()) {
  const today = pollNumber(boardDateKey(now)) ?? 1
  const start = from ?? today
  const [polls, rows] = await Promise.all([
    pollsBetween(start, start + count - 1),
    db().select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, QUEUE_KEY)),
  ])
  return { today, total: parseQueue(rows[0]?.value)?.items.length ?? POLLS.length, polls }
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
  /** How many of his questions the player has answered, ever, toward Blip's set; null for a visitor. */
  answers: number | null
}

/**
 * How many of Blip's questions an account has answered on their day, ever: its poll rows that paid. A past one
 * answered late (answerPastPoll) is a row of nought, and doesn't count toward his set.
 */
async function answersOf(accountId: string): Promise<number> {
  const [row] = await db()
    .select({ answers: sql<number>`count(*)::int` })
    .from(ticketLedger)
    .where(and(eq(ticketLedger.accountId, accountId), eq(ticketLedger.reason, 'poll'), gt(ticketLedger.amount, 0)))
  return Number(row?.answers ?? 0)
}

/**
 * Blip's set: the skins an account's answers have won (one every BLIP_SKIN_EVERY, in BLIP_SKINS's order), given
 * if it doesn't have them yet. Says which were new.
 */
async function giveBlipSkins(accountId: string, answers: number, now: number): Promise<string[]> {
  const won = BLIP_SKINS.slice(0, Math.floor(answers / BLIP_SKIN_EVERY)).map(([id]) => id)
  if (!won.length) return []
  const added = await db()
    .insert(prizesOwned)
    .values(won.map((prizeId) => ({ accountId, prizeId, price: 0, at: now })))
    .onConflictDoNothing()
    .returning({ prizeId: prizesOwned.prizeId })
  return added.map((row) => row.prizeId)
}

/** Blip's question for a player (or a visitor, `null`): today's, its counts once they've answered, yesterday's result. */
export async function pollView(accountId: string | null, now = Date.now()): Promise<PollView> {
  const n = pollNumber(boardDateKey(now))
  if (n == null) {
    return { today: null, yesterday: null, tomorrow: null, tickets: POLL_TICKETS, answers: accountId ? await answersOf(accountId) : null }
  }
  // Side by side, not one after another: each is a round trip, and answering waits on all of them.
  const [answers, around, pick] = await Promise.all([
    accountId ? answersOf(accountId) : null,
    pollsBetween(Math.max(1, n - 1), n + 1),
    accountId ? pickOf(accountId, n) : null,
  ])
  const poll = around.find((p) => p.n === n)!
  const before = around.find((p) => p.n === n - 1) ?? null
  const after = around.find((p) => p.n === n + 1) ?? null
  const [counts, beforeCounts] = await Promise.all([
    pick == null ? null : countsFor(n, poll.options.length, now),
    before ? countsFor(before.n, before.options.length, now) : null,
  ])
  const today = { ...poll, pick, ...counts }
  const yesterday = before && beforeCounts ? { ...before, ...beforeCounts } : null
  return { today, yesterday, tomorrow: after?.q ?? null, tickets: POLL_TICKETS, answers }
}

/**
 * Past questions' answers, kept a short while: they still come in, late (answerPastPoll), but slowly. A player's
 * own late answer drops its question's, so they see it counted.
 */
const final = new Map<number, { at: number; value: PollCounts }>()
const FINAL_KEEP = 500
const FINAL_FOR_MS = 60 * 1000

/** Past questions' counts, those not kept yet in one look at the ledger. */
async function finalCounts(polls: Poll[], now: number): Promise<Map<number, PollCounts>> {
  const missing = polls.filter((p) => {
    const kept = final.get(p.n)
    return !kept || now - kept.at >= FINAL_FOR_MS
  })
  if (missing.length) {
    const rows = await db()
      .select({ ref: ticketLedger.ref, pick: sql<string>`${ticketLedger.detail}->>'pick'`, votes: sql<number>`count(*)::int` })
      .from(ticketLedger)
      .where(and(eq(ticketLedger.reason, 'poll'), inArray(ticketLedger.ref, missing.map((p) => ref(p.n)))))
      .groupBy(ticketLedger.ref, sql`${ticketLedger.detail}->>'pick'`)
    for (const p of missing) {
      const counts = Array.from({ length: p.options.length }, () => 0)
      for (const row of rows) {
        if (row.ref !== ref(p.n)) continue
        const pick = Number(row.pick)
        if (Number.isInteger(pick) && pick >= 0 && pick < counts.length) counts[pick]! += Number(row.votes)
      }
      final.delete(p.n)
      final.set(p.n, { at: now, value: { counts, total: counts.reduce((a, b) => a + b, 0) } })
      if (final.size > FINAL_KEEP) final.delete(final.keys().next().value!)
    }
  }
  return new Map(polls.map((p) => [p.n, final.get(p.n)!.value]))
}

export type PastPoll = Poll & PollCounts & { pick: number | null }

/**
 * Blip's past questions (the "Blip's questions" page), newest first: up to `count` from the one before `before`
 * (yesterday's, by default), each with how everyone answered and the player's answer. `next` asks for older ones.
 */
export async function pastPolls(
  accountId: string | null,
  before: number | null,
  count: number,
  now = Date.now(),
): Promise<{ today: number | null; polls: PastPoll[]; next: number | null; answers: number | null }> {
  const today = pollNumber(boardDateKey(now))
  const top = Math.min(before ?? Number.MAX_SAFE_INTEGER, today ?? 1) - 1
  if (top < 1) return { today, polls: [], next: null, answers: accountId ? await answersOf(accountId) : null }
  const from = Math.max(1, top - count + 1)
  const polls = (await pollsBetween(from, top)).reverse()
  const refs = polls.map((p) => ref(p.n))
  const [counts, picks, answers] = await Promise.all([
    finalCounts(polls, now),
    accountId
      ? db()
          .select({ ref: ticketLedger.ref, detail: ticketLedger.detail })
          .from(ticketLedger)
          .where(and(eq(ticketLedger.accountId, accountId), eq(ticketLedger.reason, 'poll'), inArray(ticketLedger.ref, refs)))
      : [],
    accountId ? answersOf(accountId) : null,
  ])
  const pickBy = new Map<string, number>()
  for (const row of picks) {
    const pick = (row.detail as { pick?: unknown } | null)?.pick
    if (typeof pick === 'number') pickBy.set(row.ref, pick)
  }
  return {
    today,
    polls: polls.map((p) => ({ ...p, ...counts.get(p.n)!, pick: pickBy.get(ref(p.n)) ?? null })),
    next: from > 1 ? from : null,
    answers,
  }
}

/**
 * Answer a past question, late (Ramsey, 2026-10-21: "we should let people still vote on older ones too"): once
 * each, counted with everyone's, but for no tickets and not toward Blip's set, which stay the day's question's,
 * so a backlog of them is nothing to farm. Says the question as it now stands, with the player's answer.
 */
export async function answerPastPoll(accountId: string, n: number, pick: number, now = Date.now()): Promise<PastPoll> {
  const today = pollNumber(boardDateKey(now))
  if (today == null || n < 1 || n >= today) {
    throw Object.assign(new Error('That isn’t a past question'), { status: 404, code: 'NO_POLL' })
  }
  const poll = await pollAt(n)
  if (!Number.isInteger(pick) || pick < 0 || pick >= poll.options.length) {
    throw Object.assign(new Error('That isn’t one of the answers'), { status: 400, code: 'BAD_PICK' })
  }
  await awardTickets(accountId, 'poll', ref(n), 0, null, now, { pick, label: poll.q })
  final.delete(n)
  const [counts, mine] = await Promise.all([finalCounts([poll], now), pickOf(accountId, n)])
  return { ...poll, ...counts.get(n)!, pick: mine }
}

/** Answer today's question: once a day, for POLL_TICKETS, and toward Blip's set: `won` is a skin this answer won. */
export async function answerPoll(
  accountId: string,
  pick: number,
  now = Date.now(),
): Promise<PollView & { earned: number; won: string | null }> {
  const n = pollNumber(boardDateKey(now))
  if (n == null) throw Object.assign(new Error('There’s no question today'), { status: 404, code: 'NO_POLL' })
  const poll = await pollAt(n)
  if (!Number.isInteger(pick) || pick < 0 || pick >= poll.options.length) {
    throw Object.assign(new Error('That isn’t one of the answers'), { status: 400, code: 'BAD_PICK' })
  }
  const detail: TicketDetail = { pick, label: poll.q }
  const { earned } = await awardTickets(accountId, 'poll', ref(n), POLL_TICKETS, null, now, detail)
  counted.delete(n)
  // An answer that counted may win the next skin of Blip's set; looked at alongside the view it answers with.
  const [won, view] = await Promise.all([
    earned > 0 ? answersOf(accountId).then((answers) => giveBlipSkins(accountId, answers, now)) : [],
    pollView(accountId, now),
  ])
  return { ...view, earned, won: won.at(-1) ?? null }
}
