import { sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { BOARD_TZ, boardDateKey, previousBoardDateKey } from './store.js'

/*
 * Who's playing, for the admin page's Players card (Ramsey, 2026-10-01: "let's do 6 and 7. it'd be nice to
 * see number of active players too").
 *
 * Nothing new is tracked. A player is active on a day they saved a run (a board row under one of their tags)
 * or a daily hole result, on the boards' clock. That's every signed-in player who played: saving needs an
 * account. Signed-out play shows only as runs started (game_runs keeps a day of them, with no account).
 * The seeded world's players (seed-acct-*) are left out unless asked for: they'd swamp the real ones.
 */

/** Days of activity read: the 30-day count, plus a week before it for the week-later return rate. */
const READ_DAYS = 40
/** The daily chart: this many days, ending today. */
const CHART_DAYS = 14
/** Return rates look at players who signed up in this many days before the last whole one. */
const COHORT_DAYS = 30

const SEEDED = 'seed-acct-%'
const tz = sql.raw(`'${BOARD_TZ.replace(/'/g, '')}'`)

const dayOf = (key: number) => {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** `days` board days ending with `last` (a day key), newest first. */
function daysBack(last: number, days: number): number[] {
  const out: number[] = []
  for (let i = 0, d = last; i < days; i++, d = previousBoardDateKey(d)) out.push(d)
  return out
}

export type Rate = { players: number; back: number }

export type PlayerStats = {
  /** The boards' day the numbers run to, YYYY-MM-DD. */
  day: string
  includeSeeded: boolean
  /** Accounts in all, and how many have ever saved a run. */
  accounts: { total: number; saved: number }
  /** Distinct players who played: today, the last 7 days and the last 30, today included. */
  active: { day: number; week: number; month: number }
  /** Accounts made in the same windows. */
  joined: { day: number; week: number; month: number }
  /**
   * Of the players who signed up in the 30 days before the last whole day: how many played again the next day;
   * and of those who signed up 30 days before the last whole week, how many played on any of the 7 days after.
   */
  returned: { nextDay: Rate; week: Rate }
  /** Each of the last 14 days, oldest first: players who played, and accounts made. */
  days: { day: string; active: number; joined: number }[]
  /** Runs begun in the last 24 hours, signed in or not: the only trace of signed-out play. */
  runs24h: { total: number; signedOut: number }
}

export async function playerStats(now = Date.now(), includeSeeded = false): Promise<PlayerStats> {
  const today = boardDateKey(now)
  const fromMs = now - READ_DAYS * 86_400_000
  const notSeeded = (column: ReturnType<typeof sql.raw>) => (includeSeeded ? sql`true` : sql`${column} not like ${SEEDED}`)

  const [played, joinedRows, totals, runs] = await Promise.all([
    db().execute<{ account: string; day: string }>(sql`
      select distinct nc.account_id as account,
             to_char(to_timestamp(ls.at / 1000.0) at time zone ${tz}, 'YYYYMMDD') as day
        from leaderboard_scores ls
        join name_claims nc on nc.name = ls.name
       where nc.account_id is not null and ls.at >= ${fromMs} and ${notSeeded(sql.raw('nc.account_id'))}
      union
      select account_id as account, replace(day, '-', '') as day
        from daily_hole_results
       where solved_at >= ${fromMs} and ${notSeeded(sql.raw('account_id'))}
    `),
    db().execute<{ id: string; created_at: string }>(sql`
      select id, created_at from accounts where created_at >= ${fromMs} and ${notSeeded(sql.raw('id'))}
    `),
    db().execute<{ accounts: number; saved: number }>(sql`
      select (select count(*)::int from accounts where ${notSeeded(sql.raw('id'))}) as accounts,
             (select count(distinct account_id)::int from name_claims
               where account_id is not null and ${notSeeded(sql.raw('account_id'))}
                 and name in (select distinct name from leaderboard_scores)) as saved
    `),
    db().execute<{ total: number; signed_out: number }>(sql`
      select count(*)::int as total, count(*) filter (where account_id is null)::int as signed_out
        from game_runs where started_at >= ${now - 86_400_000}
    `),
  ])

  // Who played on which day, and when each account was made.
  const playedOn = new Map<number, Set<string>>()
  for (const row of played) {
    const day = Number(row.day)
    let set = playedOn.get(day)
    if (!set) playedOn.set(day, (set = new Set()))
    set.add(row.account)
  }
  const joinedOn = new Map<string, number>()
  for (const row of joinedRows) joinedOn.set(row.id, boardDateKey(Number(row.created_at)))

  const activeIn = (days: number[]) => {
    const who = new Set<string>()
    for (const d of days) for (const a of playedOn.get(d) ?? []) who.add(a)
    return who.size
  }
  const joinedIn = (days: number[]) => {
    const set = new Set(days)
    let n = 0
    for (const d of joinedOn.values()) if (set.has(d)) n++
    return n
  }

  // Return rates, only over whole days: the next day must be over, and for the week all seven after.
  const yesterday = previousBoardDateKey(today)
  const nextDayCohort = daysBack(previousBoardDateKey(yesterday), COHORT_DAYS)
  const weekCohort = daysBack(daysBack(yesterday, 8).at(-1)!, COHORT_DAYS)
  // The days read, oldest first, for the days after a signup.
  const window = daysBack(today, READ_DAYS + 2).reverse()
  const after = (day: number, n: number) => {
    const i = window.indexOf(day)
    return i < 0 ? [] : window.slice(i + 1, i + 1 + n)
  }
  const rate = (cohort: number[], days: number): Rate => {
    const set = new Set(cohort)
    let players = 0
    let back = 0
    for (const [account, joined] of joinedOn) {
      if (!set.has(joined)) continue
      players++
      if (after(joined, days).some((d) => playedOn.get(d)?.has(account))) back++
    }
    return { players, back }
  }

  const week = daysBack(today, 7)
  const month = daysBack(today, 30)
  return {
    day: dayOf(today),
    includeSeeded,
    accounts: { total: totals[0]?.accounts ?? 0, saved: totals[0]?.saved ?? 0 },
    active: { day: activeIn([today]), week: activeIn(week), month: activeIn(month) },
    joined: { day: joinedIn([today]), week: joinedIn(week), month: joinedIn(month) },
    returned: { nextDay: rate(nextDayCohort, 1), week: rate(weekCohort, 7) },
    days: daysBack(today, CHART_DAYS)
      .reverse()
      .map((d) => ({ day: dayOf(d), active: playedOn.get(d)?.size ?? 0, joined: joinedIn([d]) })),
    runs24h: { total: runs[0]?.total ?? 0, signedOut: runs[0]?.signed_out ?? 0 },
  }
}
