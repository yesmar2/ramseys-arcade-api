import { sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { seasonNow } from './seasons.js'
import { BOARD_TZ, boardDateKey } from './store.js'

/*
 * The three numbers that say whether the arcade is working, at the top of the admin page (Ramsey, 2026-10-22:
 * "lets see the numbers"). They're the ones I said to watch from launch (2026-10-15): do new players come back,
 * do they share, do they pay.
 *
 * - Stayed: of the players who made an account, how many still played in their second week: on any of the 7th
 *   to 13th days after the day they joined. Played means saved a run (a board row under one of their tags) or
 *   a daily hole result, as on the Players card (playerStats.ts). Saving needs an account, so signed-out play
 *   isn't in it.
 * - Shared: how many of the last 7 days' players sent something on, and how many shares went in all, signed
 *   in or not (shares.ts).
 * - Paying: the accounts paying for Plus, or that bought this season's Gold Pass, against the last 30 days'
 *   players. A free week of Plus isn't paying, and nor is an admin's grant.
 *
 * Days and weeks are the boards' (America/New_York, weeks from Monday). The seeded world's accounts are left
 * out. Everything is counted in the database, so the card stays quick however many players there are.
 */

/** Weeks of joiners and of shares the card shows, this one included. */
const WEEKS = 6
/** The headline's stayed rate is over the latest this many weeks of joiners whose second weeks are over. */
const HEADLINE_WEEKS = 4
const SEEDED = 'seed-acct-%'
const tz = sql.raw(`'${BOARD_TZ.replace(/'/g, '')}'`)

/* Day keys (YYYYMMDD), as the boards write them. */
const keyDate = (key: number) => new Date(Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100))
const dateKey = (d: Date) => d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
function addDays(key: number, n: number): number {
  const d = keyDate(key)
  d.setUTCDate(d.getUTCDate() + n)
  return dateKey(d)
}
/** The Monday of a day's week. */
function mondayOf(key: number): number {
  return addDays(key, -((keyDate(key).getUTCDay() + 6) % 7))
}
function dayText(key: number): string {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** A week of joiners, Monday to Sunday, and how many of them played in their second week. */
export type Cohort = {
  from: string
  to: string
  players: number
  back: number
  /** done: every joiner's second week is over. soFar: it has begun for some. tooSoon: for none yet. */
  state: 'done' | 'soFar' | 'tooSoon'
}

/** A week's shares, Monday to Sunday: how many went, from how many signed-in players, of the week's players. */
export type ShareWeek = { from: string; shares: number; sharers: number; players: number }

export type LaunchNumbers = {
  /** The boards' day the numbers run to, YYYY-MM-DD. */
  day: string
  stayed: {
    /** Over the latest HEADLINE_WEEKS whole weeks of joiners, from the Monday of the first to the Sunday of the last. */
    players: number
    back: number
    from: string | null
    to: string | null
    /** Newest first. */
    cohorts: Cohort[]
  }
  shared: {
    /** The last 7 days, today so far included: the players, those of them who shared, and the shares. */
    players: number
    sharers: number
    shares: number
    /** Shares sent signed out: counted, but nobody to tie them to. */
    signedOut: number
    kinds: { kind: string; shares: number }[]
    /** Newest first. */
    weeks: ShareWeek[]
  }
  paying: {
    /** The last 30 days' players, today so far included. */
    players: number
    /** Accounts paying for Plus or holding a bought Gold Pass for this season, each once. */
    paying: number
    plus: number
    trial: number
    goldPass: number
    season: { id: number; name: string } | null
  }
}

type Row = Record<string, unknown>
const num = (v: unknown) => Number(v ?? 0) || 0

export async function launchNumbers(now = Date.now()): Promise<LaunchNumbers> {
  const today = boardDateKey(now)
  const yesterday = addDays(today, -1)
  const thisMonday = mondayOf(today)
  const firstMonday = addDays(thisMonday, -7 * (WEEKS - 1))
  // A day early, so no run on the first Monday is missed whatever the clocks did: what's read is grouped by day.
  const fromMs = keyDate(firstMonday).getTime() - 86_400_000
  const week = dayText(addDays(today, -6))
  const month = dayText(addDays(today, -29))
  const season = await seasonNow(now).catch(() => null)
  const seasonId = season?.def.id ?? -1

  const [activity, shares, paid] = await Promise.all([
    db().execute<Row>(sql`
      with played as (
        select distinct nc.account_id as account, (to_timestamp(ls.at / 1000.0) at time zone ${tz})::date as day
          from leaderboard_scores ls
          join name_claims nc on nc.name = ls.name
         where nc.account_id is not null and ls.at >= ${fromMs} and nc.account_id not like ${SEEDED}
        union
        select account_id as account, day::date as day
          from daily_hole_results
         where solved_at >= ${fromMs} and account_id not like ${SEEDED}
      ),
      joined as (
        select id as account, (to_timestamp(created_at / 1000.0) at time zone ${tz})::date as day
          from accounts
         where created_at >= ${fromMs} and id not like ${SEEDED}
      )
      select
        (select coalesce(json_agg(c), '[]'::json) from (
           select to_char(date_trunc('week', j.day), 'YYYYMMDD') as week,
                  count(*)::int as players,
                  count(*) filter (where exists (
                    select 1 from played p where p.account = j.account and p.day between j.day + 7 and j.day + 13
                  ))::int as back
             from joined j
            group by 1
        ) c) as cohorts,
        (select coalesce(json_agg(w), '[]'::json) from (
           select to_char(date_trunc('week', day), 'YYYYMMDD') as week, count(distinct account)::int as players
             from played
            group by 1
        ) w) as weeks,
        (select count(distinct account)::int from played where day >= ${week}::date) as week_players,
        (select count(distinct account)::int from played where day >= ${month}::date) as month_players
    `),
    db().execute<Row>(sql`
      with shared as (
        select kind, account_id, (to_timestamp(at / 1000.0) at time zone ${tz})::date as day
          from share_events
         where at >= ${fromMs}
      )
      select
        (select coalesce(json_agg(w), '[]'::json) from (
           select to_char(date_trunc('week', day), 'YYYYMMDD') as week,
                  count(*)::int as shares,
                  count(distinct account_id)::int as sharers
             from shared
            group by 1
        ) w) as weeks,
        (select coalesce(json_agg(k), '[]'::json) from (
           select kind, count(*)::int as shares from shared where day >= ${week}::date group by kind order by 2 desc, 1
        ) k) as kinds,
        (select count(*)::int from shared where day >= ${week}::date) as shares,
        (select count(distinct account_id)::int from shared where day >= ${week}::date) as sharers,
        (select count(*)::int from shared where day >= ${week}::date and account_id is null) as signed_out
    `),
    db().execute<Row>(sql`
      with plus as (
        select account_id from memberships where source = 'stripe' and status = 'active' and account_id not like ${SEEDED}
      ),
      gold as (
        select account_id from season_plus where season = ${seasonId} and source = 'stripe' and account_id not like ${SEEDED}
      )
      select
        (select count(*)::int from plus) as plus,
        (select count(*)::int from memberships where status = 'trialing' and account_id not like ${SEEDED}) as trial,
        (select count(*)::int from gold) as gold_pass,
        (select count(*)::int from (select account_id from plus union select account_id from gold) p) as paying
    `),
  ])

  const a = activity[0] ?? {}
  const s = shares[0] ?? {}
  const p = paid[0] ?? {}
  const cohortRows = new Map((a.cohorts as { week: string; players: number; back: number }[]).map((c) => [Number(c.week), c]))
  const weekPlayers = new Map((a.weeks as { week: string; players: number }[]).map((w) => [Number(w.week), w.players]))
  const shareRows = new Map((s.weeks as { week: string; shares: number; sharers: number }[]).map((w) => [Number(w.week), w]))

  const mondays = Array.from({ length: WEEKS }, (_, i) => addDays(thisMonday, -7 * i))
  const cohorts: Cohort[] = mondays.map((monday) => {
    const sunday = addDays(monday, 6)
    const row = cohortRows.get(monday)
    // Whole days only: the last joiner's 13th day after must be over for the week to be done.
    const state = addDays(sunday, 13) <= yesterday ? 'done' : addDays(monday, 7) <= today ? 'soFar' : 'tooSoon'
    return { from: dayText(monday), to: dayText(sunday), players: row?.players ?? 0, back: row?.back ?? 0, state }
  })
  const headline = cohorts.filter((c) => c.state === 'done').slice(0, HEADLINE_WEEKS)

  return {
    day: dayText(today),
    stayed: {
      players: headline.reduce((n, c) => n + c.players, 0),
      back: headline.reduce((n, c) => n + c.back, 0),
      from: headline.at(-1)?.from ?? null,
      to: headline[0]?.to ?? null,
      cohorts,
    },
    shared: {
      players: num(a.week_players),
      sharers: num(s.sharers),
      shares: num(s.shares),
      signedOut: num(s.signed_out),
      kinds: (s.kinds as { kind: string; shares: number }[]).map((k) => ({ kind: k.kind, shares: num(k.shares) })),
      weeks: mondays.map((monday) => {
        const row = shareRows.get(monday)
        return { from: dayText(monday), shares: row?.shares ?? 0, sharers: row?.sharers ?? 0, players: weekPlayers.get(monday) ?? 0 }
      }),
    },
    paying: {
      players: num(a.month_players),
      paying: num(p.paying),
      plus: num(p.plus),
      trial: num(p.trial),
      goldPass: num(p.gold_pass),
      season: season ? { id: season.def.id, name: season.def.name } : null,
    },
  }
}
