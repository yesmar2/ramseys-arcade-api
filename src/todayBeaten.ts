import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { dailyHoleResults, leaderboardScores } from './db/schema.js'
import { listFriends } from './friends.js'
import { namesOwnedByAccount } from './names.js'
import { notify } from './notifications.js'
import { boardDateKey, dayStartMs } from './store.js'
import { scoreFigure } from './words.js'

/*
 * A friend beat you on one of today's three (the Today set, today.ts). When a player's result on Today's
 * Hole, Today's Track or Today's Wanted is better than a friend's on it today, that friend hears so in
 * their inbox: once a day for each daily and each friend who beats them. Only a friend who has played it
 * today is told; someone who hasn't isn't beaten yet. A lap can be driven again the same day, so its
 * note says there's still time; the hole and the bugs count once a day. That's why the lap is a topic of
 * its own in the player's notification settings, and one that goes to their phone by default
 * (notificationSettings.ts). The saves of the three call this (routes.ts for the lap and the bugs,
 * dailyHole.ts for the hole), without waiting on it, since a push can take a moment.
 */

export type TodayGame = 'acechase' | 'hotlap' | 'findbug'

const WHAT: Record<TodayGame, { daily: string; mine: string }> = {
  acechase: { daily: 'Today’s Hole', mine: 'you on' },
  hotlap: { daily: 'Today’s Track', mine: 'your lap on' },
  findbug: { daily: 'Today’s Wanted', mine: 'you on' },
}

const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`

/** A result in words: tries on the hole, a lap or a run's time. */
function resultWords(game: TodayGame, value: number): string {
  return game === 'acechase' ? tries(value) : scoreFigure(game, value)
}

/** Whether `a` beats `b`: fewer tries on the hole, a higher board score (a quicker time) on the others. */
function beats(game: TodayGame, a: number, b: number): boolean {
  return game === 'acechase' ? a < b : a > b
}

export async function tellBeatenFriends(opts: { accountId: string; game: TodayGame; now?: number }): Promise<number> {
  const now = opts.now ?? Date.now()
  const today = boardDateKey(now)
  const start = dayStartMs(today)
  // Thirty hours on is always the next day, however long a day is when the clocks change.
  const end = dayStartMs(boardDateKey(start + 30 * 3_600_000))
  const day = `${String(today).slice(0, 4)}-${String(today).slice(4, 6)}-${String(today).slice(6, 8)}`

  const [mine] = await namesOwnedByAccount(opts.accountId)
  if (!mine) return 0
  const friends = (await listFriends(opts.accountId)).filter((f) => f.name && f.name !== mine.name)
  if (!friends.length) return 0

  // Your result today, and each friend's who has one.
  let yours: number | null = null
  const theirs = new Map<string, number>()
  if (opts.game === 'acechase') {
    const ids = [opts.accountId, ...friends.map((f) => f.accountId)]
    const rows = await db()
      .select({ accountId: dailyHoleResults.accountId, tries: dailyHoleResults.tries })
      .from(dailyHoleResults)
      .where(and(eq(dailyHoleResults.day, day), inArray(dailyHoleResults.accountId, ids)))
    for (const row of rows) {
      if (row.accountId === opts.accountId) yours = row.tries
      else theirs.set(row.accountId, row.tries)
    }
  } else {
    const names = [mine.name, ...friends.map((f) => f.name)]
    const rows = await db()
      .select({ name: leaderboardScores.name, best: sql<number>`max(${leaderboardScores.score})::int` })
      .from(leaderboardScores)
      .where(and(eq(leaderboardScores.game, opts.game), inArray(leaderboardScores.name, names), gte(leaderboardScores.at, start), lt(leaderboardScores.at, end)))
      .groupBy(leaderboardScores.name)
    const accountOf = new Map(friends.map((f) => [f.name, f.accountId]))
    for (const row of rows) {
      if (row.name === mine.name) yours = Number(row.best)
      else {
        const accountId = accountOf.get(row.name)
        if (accountId) theirs.set(accountId, Number(row.best))
      }
    }
  }
  if (yours == null) return 0

  const what = WHAT[opts.game]
  let told = 0
  for (const friend of friends) {
    const theirResult = theirs.get(friend.accountId)
    if (theirResult == null || !beats(opts.game, yours, theirResult)) continue
    const again = opts.game === 'hotlap' ? ' There’s still time to take it back today.' : ''
    const filed = await notify({
      accountId: friend.accountId,
      kind: 'today-beaten',
      title: `${mine.name} beat ${what.mine} ${what.daily}`,
      body: `${resultWords(opts.game, yours)} to your ${resultWords(opts.game, theirResult)}.${again}`,
      href: '/?focus=today',
      meta: { actor: mine.name, game: opts.game, ...(opts.game === 'hotlap' ? { playHref: '/games/hotlap/play' } : {}) },
      digestKey: `today-beaten:${day}:${opts.game}:${opts.accountId}`,
      once: true,
      now,
    }).catch(() => null)
    if (filed?.created) told++
  }
  return told
}
