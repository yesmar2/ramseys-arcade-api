import crypto from 'node:crypto'
import { and, desc, eq, gt, gte, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { prizesOwned, ticketLedger, ticketWallets } from './db/schema.js'
import { prizeById } from './prizes.js'
import {
  boardDateKey,
  boardDayStart,
  placeOfScore,
  placePoints,
  previousBoardDateKey,
  type GameSlug,
} from './store.js'

/*
 * Tickets: what the arcade pays out for playing, spent at the prize counter on
 * looks (prizes.ts). They're kept by account, so a rename keeps them, and
 * they can't be bought: nothing but play puts one in.
 *
 * A saved run pays 1 to 10 by how much of the week's board it beats (the same
 * share the standings pay points for, a tenth of it), 5 more for a new best,
 * and whatever tickets it picked up on the way (Crosswalk's). Those stop at
 * RUN_TICKETS_PER_DAY a day, so grinding pays no more than playing. On top,
 * and uncapped: a first go at a game, the first run of each day on a streak,
 * a run in the Daily, and each day's bug caught. Only a run with a run id
 * pays, since that's the run the server timed and checked.
 *
 * Every ticket in or out is a row in the ledger, one per reason and the thing
 * it was for, so a save sent twice pays once.
 */

/** What a day's runs can pay, all told; past it the day plays for the boards alone. */
export const RUN_TICKETS_PER_DAY = 200
export const BEST_TICKETS = 5
export const FIRST_GO_TICKETS = 20
export const STREAK_TICKETS = 5
export const DAILY_TICKETS = 10
export const HUNT_TICKETS = 15

export type TicketReason = 'run' | 'best' | 'pickup' | 'first' | 'streak' | 'daily' | 'hunt' | 'grant' | 'trade'

export type TicketLine = { reason: TicketReason; amount: number }

/** What a saved run paid, for the run report. */
export type RunTickets = {
  earned: number
  lines: TicketLine[]
  balance: number
  /** The share of the week's board the run beat, 1–100: what the run line was worked out from. */
  beat: number
  /** Where the run placed among the week's players, and how many there are, the player among them. */
  place: number
  field: number
  /** Tickets the day's cap held back from this run. */
  capped: number
  /** Run tickets left today before the cap. */
  todayLeft: number
}

export type TicketsSummary = {
  balance: number
  earned: number
  /** Everything earned since the day began, and the run tickets against the cap. */
  today: { earned: number; runs: number; cap: number }
  goal: string | null
  owned: string[]
  recent: { amount: number; reason: string; game: string | null; at: number }[]
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]

const RUN_REASONS = new Set<TicketReason>(['run', 'best', 'pickup'])

function ledgerId(now: number) {
  return `${now}-${crypto.randomBytes(6).toString('base64url')}`
}

/** The wallet row, made if it isn't there, and held until the transaction ends. */
async function lockWallet(tx: Tx, accountId: string, now: number) {
  await tx.insert(ticketWallets).values({ accountId, updatedAt: now }).onConflictDoNothing()
  const [wallet] = await tx.select().from(ticketWallets).where(eq(ticketWallets.accountId, accountId)).for('update')
  return wallet!
}

/**
 * The most tickets a Crosswalk run can say it picked up: they lie on about one
 * row in ten, so a third of the rows covers any route through them.
 */
export function plausiblePickups(score: number, claimed: number | undefined): number {
  if (!claimed || claimed < 0) return 0
  return Math.min(Math.floor(claimed), Math.floor(score * 0.3) + 3)
}

/** Pay a saved run its tickets. `priorBest` is the player's best on the game before it, or null for a first go. */
export async function payRun(input: {
  accountId: string
  game: GameSlug
  name: string
  runId: string
  score: number
  priorBest: number | null
  pickups: number
  now?: number
}): Promise<RunTickets> {
  const now = input.now ?? Date.now()
  const { place, field } = await placeOfScore(input.game, 'weekly', input.name, input.score, now)
  const beat = placePoints(place, field)
  const wanted: TicketLine[] = [{ reason: 'run', amount: Math.max(1, Math.round(beat / 10)) }]
  if (input.priorBest != null && input.score > input.priorBest) wanted.push({ reason: 'best', amount: BEST_TICKETS })
  if (input.pickups > 0) wanted.push({ reason: 'pickup', amount: input.pickups })

  return db().transaction(async (tx) => {
    const wallet = await lockWallet(tx, input.accountId, now)
    const today = boardDateKey(now)
    const usedToday = wallet.runDay === today ? wallet.runToday : 0
    let room = Math.max(0, RUN_TICKETS_PER_DAY - usedToday)
    let capped = 0
    const rows: (typeof ticketLedger.$inferInsert)[] = []
    for (const line of wanted) {
      const amount = Math.min(line.amount, room)
      room -= amount
      capped += line.amount - amount
      if (amount > 0) {
        rows.push({ id: ledgerId(now), accountId: input.accountId, amount, reason: line.reason, ref: input.runId, game: input.game, at: now })
      }
    }
    if (input.priorBest == null) {
      rows.push({
        id: ledgerId(now),
        accountId: input.accountId,
        amount: FIRST_GO_TICKETS,
        reason: 'first',
        ref: input.game,
        game: input.game,
        at: now,
      })
    }
    // The first paying run of a day, the day after one: a streak goes on.
    if (wallet.runDay !== today && wallet.runDay === previousBoardDateKey(today)) {
      rows.push({
        id: ledgerId(now),
        accountId: input.accountId,
        amount: STREAK_TICKETS,
        reason: 'streak',
        ref: String(today),
        game: input.game,
        at: now,
      })
    }
    const paid = rows.length
      ? await tx
          .insert(ticketLedger)
          .values(rows)
          .onConflictDoNothing()
          .returning({ reason: ticketLedger.reason, amount: ticketLedger.amount })
      : []
    const earned = paid.reduce((sum, row) => sum + row.amount, 0)
    const runPaid = paid.filter((row) => RUN_REASONS.has(row.reason as TicketReason)).reduce((sum, row) => sum + row.amount, 0)
    const runToday = usedToday + runPaid
    await tx
      .update(ticketWallets)
      .set({
        balance: sql`${ticketWallets.balance} + ${earned}`,
        earned: sql`${ticketWallets.earned} + ${earned}`,
        runDay: today,
        runToday,
        updatedAt: now,
      })
      .where(eq(ticketWallets.accountId, input.accountId))
    return {
      earned,
      lines: paid.map((row) => ({ reason: row.reason as TicketReason, amount: row.amount })),
      balance: wallet.balance + earned,
      beat,
      place,
      field,
      capped,
      todayLeft: Math.max(0, RUN_TICKETS_PER_DAY - runToday),
    }
  })
}

/** Tickets for something done once (the day's Daily, a day's bug, an admin's grant): nothing if it was paid already. */
export async function awardTickets(
  accountId: string,
  reason: Exclude<TicketReason, 'trade'>,
  ref: string,
  amount: number,
  game: string | null = null,
  now = Date.now(),
): Promise<{ earned: number; balance: number }> {
  return db().transaction(async (tx) => {
    const added = await tx
      .insert(ticketLedger)
      .values({ id: ledgerId(now), accountId, amount, reason, ref, game, at: now })
      .onConflictDoNothing()
      .returning({ amount: ticketLedger.amount })
    const earned = added.reduce((sum, row) => sum + row.amount, 0)
    const [wallet] = await tx
      .insert(ticketWallets)
      .values({ accountId, balance: earned, earned, updatedAt: now })
      .onConflictDoUpdate({
        target: ticketWallets.accountId,
        set: {
          balance: sql`${ticketWallets.balance} + ${earned}`,
          earned: sql`${ticketWallets.earned} + ${earned}`,
          updatedAt: now,
        },
      })
      .returning({ balance: ticketWallets.balance })
    return { earned, balance: wallet?.balance ?? 0 }
  })
}

function refusal(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

/** Trade tickets for a prize. It's kept for good; one that was being saved for stops being the goal. */
export async function tradePrize(accountId: string, prizeId: string, now = Date.now()): Promise<{ balance: number }> {
  const prize = prizeById(prizeId)
  if (!prize) throw refusal('There’s no such prize', 404, 'UNKNOWN_PRIZE')
  return db().transaction(async (tx) => {
    await lockWallet(tx, accountId, now)
    const [had] = await tx
      .select({ prizeId: prizesOwned.prizeId })
      .from(prizesOwned)
      .where(and(eq(prizesOwned.accountId, accountId), eq(prizesOwned.prizeId, prizeId)))
      .limit(1)
    if (had) throw refusal('That one’s yours already', 409, 'ALREADY_OWNED')
    const [spent] = await tx
      .update(ticketWallets)
      .set({
        balance: sql`${ticketWallets.balance} - ${prize.price}`,
        goal: sql`case when ${ticketWallets.goal} = ${prizeId} then null else ${ticketWallets.goal} end`,
        updatedAt: now,
      })
      .where(and(eq(ticketWallets.accountId, accountId), gte(ticketWallets.balance, prize.price)))
      .returning({ balance: ticketWallets.balance })
    if (!spent) throw refusal('Not enough tickets for that yet', 409, 'NOT_ENOUGH_TICKETS')
    await tx.insert(prizesOwned).values({ accountId, prizeId, price: prize.price, at: now })
    await tx
      .insert(ticketLedger)
      .values({ id: ledgerId(now), accountId, amount: -prize.price, reason: 'trade', ref: prizeId, game: null, at: now })
    return { balance: spent.balance }
  })
}

/** The prize a player is saving for, or none. */
export async function setGoal(accountId: string, prizeId: string | null, now = Date.now()): Promise<string | null> {
  if (prizeId && !prizeById(prizeId)) throw refusal('There’s no such prize', 404, 'UNKNOWN_PRIZE')
  await db()
    .insert(ticketWallets)
    .values({ accountId, goal: prizeId, updatedAt: now })
    .onConflictDoUpdate({ target: ticketWallets.accountId, set: { goal: prizeId, updatedAt: now } })
  return prizeId
}

/** The prizes an account has traded for. */
export async function ownedPrizes(accountId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ prizeId: prizesOwned.prizeId })
    .from(prizesOwned)
    .where(eq(prizesOwned.accountId, accountId))
  return new Set(rows.map((row) => row.prizeId))
}

/** Everything the prize counter shows a player about their tickets. */
export async function ticketsFor(accountId: string, now = Date.now()): Promise<TicketsSummary> {
  const [wallet] = await db().select().from(ticketWallets).where(eq(ticketWallets.accountId, accountId)).limit(1)
  const owned = await db()
    .select({ prizeId: prizesOwned.prizeId })
    .from(prizesOwned)
    .where(eq(prizesOwned.accountId, accountId))
    .orderBy(prizesOwned.at)
  const recent = await db()
    .select({ amount: ticketLedger.amount, reason: ticketLedger.reason, game: ticketLedger.game, at: ticketLedger.at })
    .from(ticketLedger)
    .where(eq(ticketLedger.accountId, accountId))
    .orderBy(desc(ticketLedger.at))
    .limit(12)
  const [todays] = await db()
    .select({ earned: sql<number>`coalesce(sum(${ticketLedger.amount}), 0)::int` })
    .from(ticketLedger)
    .where(and(eq(ticketLedger.accountId, accountId), gte(ticketLedger.at, boardDayStart(now)), gt(ticketLedger.amount, 0)))
  const today = boardDateKey(now)
  return {
    balance: wallet?.balance ?? 0,
    earned: wallet?.earned ?? 0,
    today: {
      earned: todays?.earned ?? 0,
      runs: wallet && wallet.runDay === today ? wallet.runToday : 0,
      cap: RUN_TICKETS_PER_DAY,
    },
    goal: wallet?.goal ?? null,
    owned: owned.map((row) => row.prizeId),
    recent,
  }
}
