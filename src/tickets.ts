import crypto from 'node:crypto'
import { and, desc, eq, gt, gte, inArray, lt, ne, notInArray, sql } from 'drizzle-orm'
import { isBanned } from './bans.js'
import { db } from './db/client.js'
import { prizesOwned, ticketLedger, ticketWallets, type TicketDetail } from './db/schema.js'
import { getClaim } from './names.js'
import { prizeById } from './prizes.js'
import {
  boardDateKey,
  boardDayStart,
  DAILY_GAMES,
  dayPlayers,
  dayStartMs,
  isRankedGame,
  previousBoardDateKey,
  type GameSlug,
  type LeaderboardEntry,
} from './store.js'
import { ladderFor, stepFor, type LadderStep } from './ticketLadders.js'

/*
 * Tickets: what the arcade pays out for playing, spent at the prize counter on
 * looks (prizes.ts). They're kept by account, so a rename keeps them, and
 * they can't be bought: nothing but play puts one in.
 *
 * A saved run pays by the score it reached, on its game's ladder
 * (ticketLadders.ts): 1 to 10, the same whoever else is playing and whenever.
 * The dailies (Ace Chase, Hot Lap) pay their best step of the day once, as
 * it's reached, up to 15, so another lap pays only when it climbs a step; and
 * the day after, each daily's top three get DAY_TOP_TICKETS more. Other
 * games' runs pay 5 more for a new best, and whatever tickets a run picked up
 * on the way (Crosswalk's). A run's tickets stop at RUN_TICKETS_PER_DAY a day,
 * so grinding pays no more than playing. On top, and uncapped: a first go at a
 * game, the first run of each day on a streak, a run in the Daily, each day's
 * bug caught, and taking a past Hot Lap track's or Ace Chase hole's record
 * (once a track or hole). Only a run with a run id pays, since that's the run the
 * server timed and checked (a day's Ace Chase result is paid as it goes on
 * the board, dailyHole.ts).
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
/**
 * Taking a track's or hole's record after its day (trackLapsRoutes.ts, holesRoutes.ts): once a track or
 * hole an account, however many times it's lost and taken back. On its day the day's top three are paid.
 */
export const RECORD_TICKETS = 15
/** A daily's top three the day after, first to third. */
export const DAY_TOP_TICKETS = [10, 6, 3] as const
/** Players a daily's day needs before its top three are paid: a win in a field of one or two isn't one. */
export const DAY_TOP_FIELD = 3

export type TicketReason =
  | 'run'
  | 'best'
  | 'pickup'
  | 'first'
  | 'streak'
  | 'daily'
  | 'hunt'
  | 'top'
  | 'record'
  | 'grant'
  | 'trade'
  /** A Today streak's milestone (today.ts): its tickets, or a 0 that marks a look as given. */
  | 'today'
  /** A season pass level's tickets (seasons.ts). They don't count toward the pass themselves. */
  | 'season'

export type TicketLine = { reason: TicketReason; amount: number }

/** What a saved run paid, for the run report. */
export type RunTickets = {
  earned: number
  lines: TicketLine[]
  balance: number
  /** The step of its game's ladder the run reached, or null below the first, and the next one up. */
  reached: LadderStep | null
  next: LadderStep | null
  /** What a run below the first step pays, and how a daily says it. */
  base: number
  baseLabel?: string
  /** What the run's step is worth. A daily pays it once a day: what its runs already had today goes off it. */
  step: number
  paidBefore: number
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

/** What a game's runs have paid on the ladder since the day began. */
async function runTicketsToday(tx: Tx, accountId: string, game: GameSlug, now: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${ticketLedger.amount}), 0)::int` })
    .from(ticketLedger)
    .where(
      and(
        eq(ticketLedger.accountId, accountId),
        eq(ticketLedger.reason, 'run'),
        eq(ticketLedger.game, game),
        gte(ticketLedger.at, boardDayStart(now)),
      ),
    )
  return row?.n ?? 0
}

/**
 * Pay a saved run its tickets. `priorBest` is the player's best on the game before it, or null for a
 * first go; `paceMs` is Hot Lap's blue car on the day, which its ladder goes by.
 */
export async function payRun(input: {
  accountId: string
  game: GameSlug
  runId: string
  /** The run as the boards now hold it. */
  entry: LeaderboardEntry
  score: number
  priorBest: number | null
  pickups: number
  paceMs?: number | null
  now?: number
}): Promise<RunTickets> {
  const now = input.now ?? Date.now()
  const ladder = await ladderFor(input.game, now, input.paceMs)
  const { tickets: step, reached, next } = stepFor(ladder, input.score)
  const daily = DAILY_GAMES.has(input.game)

  return db().transaction(async (tx) => {
    const wallet = await lockWallet(tx, input.accountId, now)
    const today = boardDateKey(now)
    // A daily pays its best step of the day once: a run that climbs a step is paid the difference.
    const paidBefore = daily ? await runTicketsToday(tx, input.accountId, input.game, now) : 0
    const wanted: TicketLine[] = []
    if (step - paidBefore > 0) wanted.push({ reason: 'run', amount: step - paidBefore })
    // A daily's best of the day is its step; a best on the others pays on top.
    if (!daily && input.priorBest != null && input.score > input.priorBest) wanted.push({ reason: 'best', amount: BEST_TICKETS })
    if (input.pickups > 0) wanted.push({ reason: 'pickup', amount: input.pickups })
    const usedToday = wallet.runDay === today ? wallet.runToday : 0
    let room = Math.max(0, RUN_TICKETS_PER_DAY - usedToday)
    let capped = 0
    // The history shows a run's rows as one line, with the step it reached as its ladder said it then.
    const ofRun: TicketDetail = { run: input.runId, score: input.score }
    const stepDetail: TicketDetail = {
      ...ofRun,
      stepAt: reached?.at ?? null,
      ...(reached?.label ? { label: reached.label } : !reached && ladder.baseLabel ? { label: ladder.baseLabel } : {}),
      ...(paidBefore > 0 ? { before: paidBefore } : {}),
    }
    const rows: (typeof ticketLedger.$inferInsert)[] = []
    for (const line of wanted) {
      const amount = Math.min(line.amount, room)
      room -= amount
      capped += line.amount - amount
      if (amount > 0) {
        rows.push({
          id: ledgerId(now),
          accountId: input.accountId,
          amount,
          reason: line.reason,
          ref: input.runId,
          game: input.game,
          at: now,
          detail: line.reason === 'run' ? stepDetail : ofRun,
        })
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
        detail: ofRun,
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
        detail: ofRun,
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
      reached,
      next,
      base: ladder.base,
      ...(ladder.baseLabel ? { baseLabel: ladder.baseLabel } : {}),
      step,
      paidBefore,
      capped,
      todayLeft: Math.max(0, RUN_TICKETS_PER_DAY - runToday),
    }
  })
}

/** The last day whose top three have been paid, so the sweep asks once a day. */
let toppedDay = 0

/**
 * Each daily's top three from the day before, paid DAY_TOP_TICKETS by the sweep once the day is over: so
 * winning the day still counts for something, on top of the steps every run is paid as it's reached. Only
 * a day with DAY_TOP_FIELD players or more, and tags with an account behind them that isn't barred. Paid
 * once whenever the sweep runs, however many times: each is its own ledger row.
 */
export async function payDayTops(now = Date.now()): Promise<number> {
  const day = previousBoardDateKey(boardDateKey(now))
  if (toppedDay === day) return 0
  let paid = 0
  for (const game of DAILY_GAMES) {
    // A daily just for fun has no top three (store.ts UNRANKED_GAMES).
    if (!isRankedGame(game)) continue
    const players = await dayPlayers(game, day)
    if (players.length < DAY_TOP_FIELD) continue
    for (let i = 0; i < DAY_TOP_TICKETS.length && i < players.length; i++) {
      const name = players[i]!.name
      const accountId = (await getClaim(name))?.accountId
      if (!accountId || (await isBanned(name, accountId))) continue
      paid += (await awardTickets(accountId, 'top', `${game}:${day}:${i + 1}`, DAY_TOP_TICKETS[i]!, game, now)).earned
    }
  }
  toppedDay = day
  return paid
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
  if (prize.earned) throw refusal('That one’s earned with a Dailies streak, not traded for', 409, 'EARNED_ONLY')
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
  if (prizeId && prizeById(prizeId)?.earned) throw refusal('That one’s earned with a Dailies streak, not traded for', 409, 'EARNED_ONLY')
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
    // A Today milestone that gave a look, not tickets, is marked with a nought (today.ts): not a line to show.
    .where(and(eq(ticketLedger.accountId, accountId), ne(ticketLedger.amount, 0)))
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

/** What the history can be narrowed to: a run's own pay (its step, a best, pickups), everything else earned, or trades. */
export const HISTORY_KINDS = ['all', 'runs', 'bonuses', 'trades'] as const
export type HistoryKind = (typeof HISTORY_KINDS)[number]

export type LedgerLine = {
  id: string
  amount: number
  reason: string
  ref: string
  game: string | null
  at: number
  detail: TicketDetail | null
}

export type TicketHistory = {
  /** Board days with something in them, newest first, each with its rows newest first. */
  days: { day: number; lines: LedgerLine[] }[]
  /** Where the next page starts (rows from before this moment), or null when this page reaches the first ticket. */
  next: number | null
}

/** The days a page of the history holds, and the most rows read to find them. A day's runs stop paying at 200. */
const HISTORY_DAYS = 7
const HISTORY_ROWS = 600

/**
 * Every ticket in and out, a page of days at a time, for the site's ticket history (Ramsey, 2026-10-05: "a
 * page that shows how you earned tickets … lists out how you earned each of the tickets"). A page is whole
 * days on the boards' clock, so a day's totals add up; the site words each row from its reason, ref and
 * detail. A milestone that gave a look, not tickets, is a nought, and so is a streak freeze: not rows to show.
 */
export async function ticketHistory(
  accountId: string,
  options: { before?: number; kind?: HistoryKind; game?: string } = {},
): Promise<TicketHistory> {
  const kind = options.kind ?? 'all'
  const where = [eq(ticketLedger.accountId, accountId), ne(ticketLedger.amount, 0)]
  if (options.before) where.push(lt(ticketLedger.at, options.before))
  if (kind === 'runs') where.push(inArray(ticketLedger.reason, [...RUN_REASONS]))
  else if (kind === 'trades') where.push(eq(ticketLedger.reason, 'trade'))
  else if (kind === 'bonuses') where.push(notInArray(ticketLedger.reason, [...RUN_REASONS, 'trade']))
  if (options.game) where.push(eq(ticketLedger.game, options.game))
  const rows = await db()
    .select({
      id: ticketLedger.id,
      amount: ticketLedger.amount,
      reason: ticketLedger.reason,
      ref: ticketLedger.ref,
      game: ticketLedger.game,
      at: ticketLedger.at,
      detail: ticketLedger.detail,
    })
    .from(ticketLedger)
    .where(and(...where))
    .orderBy(desc(ticketLedger.at), desc(ticketLedger.id))
    .limit(HISTORY_ROWS + 1)

  const days: TicketHistory['days'] = []
  for (const row of rows.slice(0, HISTORY_ROWS)) {
    const day = boardDateKey(row.at)
    const last = days[days.length - 1]
    if (last?.day === day) last.lines.push(row)
    else days.push({ day, lines: [row] })
  }
  let next: number | null = null
  if (days.length > HISTORY_DAYS) {
    days.length = HISTORY_DAYS
    next = dayStartMs(days[HISTORY_DAYS - 1]!.day)
  } else if (rows.length > HISTORY_ROWS) {
    if (days.length > 1) {
      // The rows ran out partway through the last day: it comes whole on the next page.
      days.pop()
      next = dayStartMs(days[days.length - 1]!.day)
    } else {
      // A day longer than a page, which the cap on runs keeps from happening: the rest of it comes next.
      next = rows[HISTORY_ROWS - 1]!.at
    }
  }
  return { days, next }
}
