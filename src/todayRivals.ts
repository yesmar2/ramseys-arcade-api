import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { dailyHoleResults, leaderboardScores, nameClaims } from './db/schema.js'
import { listFriends } from './friends.js'
import { assertGroupBoardAccess, listGroupsFor } from './groups.js'
import { namesOwnedByAccount, withAvatarIds } from './names.js'
import { BOARD_TZ, DAILY_SINCE, boardDateKey } from './store.js'
import { TODAY_SINCE, freezeGrants, keptDays, todayRule, walkStreak } from './today.js'

/*
 * Rivals on the Today set (today.ts): how an account's friends, or one of its groups, are doing on the
 * day's dailies, beside the account itself. Each player's result on each (tries on the hole, their best
 * lap, their run for the bugs, their pour, their best run down the course) and their Today streak, for the site's rivals table under
 * today's ticket (components/TodayRivals.tsx). A pour is there whether or not it's on today's card yet;
 * the site shows the dailies that are, and the streak counts only those (today.ts keptDay). A player is a
 * tag: a friend's is the one their account plays as, a group's are its roster. The hole's results are kept
 * by account, so a roster tag no account holds has none.
 */

export type Rival = {
  name: string
  me: boolean
  /** Tries on today's hole, the best lap's board score, the bug run's, the pour's, the best marble run's and the best cave run's; null if not yet. */
  hole: number | null
  track: number | null
  wanted: number | null
  pour: number | null
  course: number | null
  cave: number | null
  /** Today streak: from today once today is kept, else from yesterday. */
  streak: number
}

export type RivalsScope = { kind: 'friends' } | { kind: 'group'; id: string; name: string }

export type RivalsReply = {
  day: string
  scope: RivalsScope
  rivals: (Rival & { avatarId: string })[]
  /** The account's groups, to pick one instead of friends. */
  groups: { id: string; name: string }[]
}

/** How far back a rival's streak is counted. */
const RIVAL_LOOKBACK_DAYS = 120

const dayOf = (key: number) => {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/**
 * A board day key worked out in the database, in the boards' own time zone. The zone is written into the
 * query rather than bound, so the grouping and the selected column are the same expression.
 */
const dayKeySql = sql<number>`to_char(to_timestamp(${leaderboardScores.at} / 1000.0) at time zone ${sql.raw(`'${BOARD_TZ.replace(/'/g, '')}'`)}, 'YYYYMMDD')::int`

type Player = { name: string; accountId: string | null; me: boolean }

/** Who's in: the account's tag, and its friends' or a group's. */
async function playersFor(
  accountId: string,
  groupId: string | null,
): Promise<{ players: Player[]; scope: RivalsScope }> {
  const [mine] = await namesOwnedByAccount(accountId)
  const me: Player[] = mine ? [{ name: mine.name, accountId, me: true }] : []
  if (!groupId) {
    const friends = await listFriends(accountId)
    return {
      players: [...me, ...friends.filter((f) => f.name && f.name !== mine?.name).map((f) => ({ name: f.name, accountId: f.accountId, me: false }))],
      scope: { kind: 'friends' },
    }
  }
  const group = await assertGroupBoardAccess(groupId, { accountId })
  const names = [...new Set(group.members.map((m) => m.name).filter(Boolean))]
  const claims = names.length
    ? await db().select({ name: nameClaims.name, accountId: nameClaims.accountId }).from(nameClaims).where(inArray(nameClaims.name, names))
    : []
  const accountOf = new Map(claims.map((c) => [c.name, c.accountId]))
  const players = names.map((name) => ({ name, accountId: accountOf.get(name) ?? null, me: name === mine?.name }))
  // The viewer is always on the table, as a member of their own group.
  if (mine && !players.some((p) => p.me)) players.unshift(me[0]!)
  return { players, scope: { kind: 'group', id: group.id, name: group.name } }
}

export async function todayRivals(accountId: string, groupId: string | null, now = Date.now()): Promise<RivalsReply> {
  const today = boardDateKey(now)
  // A rival's streak counts its freezes as the player's own card does (today.ts walkStreak), over the lookback.
  const walkFrom = Math.max(TODAY_SINCE, boardDateKey(now - RIVAL_LOOKBACK_DAYS * 86_400_000))
  const [{ players, scope }, groups] = await Promise.all([
    playersFor(accountId, groupId),
    listGroupsFor({ accountId }).then((list) => list.map((g) => ({ id: g.id, name: g.name }))),
  ])
  const names = players.map((p) => p.name)
  const accounts = [...new Set(players.map((p) => p.accountId).filter((id): id is string => Boolean(id)))]
  const fromMs = now - RIVAL_LOOKBACK_DAYS * 86_400_000
  const fromDay = dayOf(boardDateKey(fromMs))

  // One look at each daily for everyone: the day's result, per player per day.
  const perDay = (game: 'hotlap' | 'findbug' | 'halffull' | 'marblerun' | 'lander') =>
    names.length
      ? db()
          .select({ name: leaderboardScores.name, day: dayKeySql, best: sql<number>`max(${leaderboardScores.score})::int` })
          .from(leaderboardScores)
          .where(and(eq(leaderboardScores.game, game), inArray(leaderboardScores.name, names), gte(leaderboardScores.at, fromMs)))
          .groupBy(leaderboardScores.name, dayKeySql)
      : Promise.resolve([] as { name: string; day: number; best: number }[])
  const [holes, laps, finds, pours, courses, caves] = await Promise.all([
    accounts.length
      ? db()
          .select({ accountId: dailyHoleResults.accountId, day: dailyHoleResults.day, tries: dailyHoleResults.tries })
          .from(dailyHoleResults)
          .where(and(inArray(dailyHoleResults.accountId, accounts), gte(dailyHoleResults.day, fromDay)))
      : Promise.resolve([] as { accountId: string; day: string; tries: number }[]),
    perDay('hotlap'),
    perDay('findbug'),
    perDay('halffull'),
    perDay('marblerun'),
    perDay('lander'),
  ])

  const holeDays = new Map<string, Map<number, number>>()
  for (const h of holes) {
    const days = holeDays.get(h.accountId) ?? new Map<number, number>()
    days.set(Number(h.day.replace(/-/g, '')), h.tries)
    holeDays.set(h.accountId, days)
  }
  const byName = (rows: { name: string; day: number; best: number }[], since = 0) => {
    const out = new Map<string, Map<number, number>>()
    for (const row of rows) {
      // As on the player's own card (today.ts): a run from before its game was a daily isn't a day of it.
      if (Number(row.day) < since) continue
      const days = out.get(row.name) ?? new Map<number, number>()
      days.set(Number(row.day), Number(row.best))
      out.set(row.name, days)
    }
    return out
  }
  const lapDays = byName(laps)
  const findDays = byName(finds, DAILY_SINCE.findbug)
  const pourDays = byName(pours, DAILY_SINCE.halffull)
  const courseDays = byName(courses, DAILY_SINCE.marblerun)
  const caveDays = byName(caves, DAILY_SINCE.lander)

  // Freezes given by hand count in a rival's streak as in their own (today.ts freezeGrants).
  const grants = await freezeGrants(accounts)
  const rivals: Rival[] = players.map((p) => {
    const hole = (p.accountId && holeDays.get(p.accountId)) || new Map<number, number>()
    const track = lapDays.get(p.name) ?? new Map<number, number>()
    const wanted = findDays.get(p.name) ?? new Map<number, number>()
    const pour = pourDays.get(p.name) ?? new Map<number, number>()
    const course = courseDays.get(p.name) ?? new Map<number, number>()
    const cave = caveDays.get(p.name) ?? new Map<number, number>()
    return {
      name: p.name,
      me: p.me,
      hole: hole.get(today) ?? null,
      track: track.get(today) ?? null,
      wanted: wanted.get(today) ?? null,
      pour: pour.get(today) ?? null,
      course: course.get(today) ?? null,
      cave: cave.get(today) ?? null,
      streak: walkStreak(
        keptDays({ hole, track, wanted, pour, course, cave }),
        today,
        walkFrom,
        p.accountId ? grants.get(p.accountId) : undefined,
      ).current,
    }
  })
  // Whoever has done most of today's card first.
  const { live } = todayRule(today)
  const doneCount = (r: Rival) => live.filter((key) => r[key] != null).length
  rivals.sort((a, b) => doneCount(b) - doneCount(a) || b.streak - a.streak || a.name.localeCompare(b.name))
  return { day: dayOf(today), scope, rivals: await withAvatarIds(rivals), groups }
}
