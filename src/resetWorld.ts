import { and, eq, inArray, isNotNull, isNull, like, notLike, or, sql } from 'drizzle-orm'
import { encodeAvatar, parseAvatar, type Avatar } from './avatars.js'
import { db } from './db/client.js'
import { accounts, appMeta, directedInvites, friendRequests, friendships, groupMembers, groups, nameClaims, trophyCursor } from './db/schema.js'
import { isFinishBadge } from './prizes.js'

/*
 * Starting over before launch. Ramsey, 2026-10-16: "i want to clear all the data there before" testers are let
 * in, and "when go live hits i want to reset the data again". It keeps who people are: accounts and their
 * sign-ins, tags, friends and groups, notification settings and push devices, Plus, and the launch email list,
 * feedback and bans. Everything played goes: runs, boards, record books, medals, laps, ghosts, holes, bug hunts,
 * challenges, tickets (Blip's poll answers are ticket rows) and prizes, trophies, season progress, events and
 * their invites, notifications and score flags. The sample players go entirely. And what an avatar wore from
 * all that comes off it, as an avatar is saved on its tag (avatars.ts): a prize counter finish goes back to the
 * plain badge, and its ring, its pin (but the welcome pin everyone has) and the prizes it wore go. Its emblem or
 * monogram and colours stay. Ramsey, after the first reset: "my users (DAD) stuff from the store wasn't removed".
 *
 * It's the admin page's Reset test data (adminRoutes.ts, /reset), and it stops working when launch day is over,
 * so nothing can empty the live arcade by mistake later. The time it ran goes in app_meta as data_reset_at; the
 * season answer carries it, and a device that sees a newer one forgets the scores it kept (the site's
 * lib/dataReset.ts).
 */

/** The end of launch day in New York (Nov 15, 00:00 EST): after this, the reset refuses. */
export const RESET_UNTIL = Date.UTC(2026, 10, 15, 5, 0, 0)

/** Every table that holds play. Emptied in one statement, so the links among them don't need an order. */
const PLAY_TABLES = [
  'game_runs',
  'leaderboard_scores',
  'record_scores',
  'run_claims',
  'score_flags',
  'course_bests',
  'track_laps',
  'lap_ghosts',
  'day_ghosts',
  'hole_results',
  'daily_hole_results',
  'bug_hunt_finds',
  'challenges',
  'challenge_results',
  'ticket_wallets',
  'ticket_ledger',
  'prizes_owned',
  'season_progress',
  'trophy_awards',
  'notifications',
  'push_ledger',
  'tournaments',
  'tournament_players',
  'tournament_scores',
  'change_feed',
  'email_codes',
  'magic_links',
] as const

const SAMPLE_EMAIL = '%@seed.skermix.dev'
const SAMPLE_ACCOUNT = 'seed-acct-%'
const SAMPLE_ROW = 'seed-%'

export type ResetCounts = {
  /** Kept. */
  players: number
  launchList: number
  feedback: number
  /** Gone. */
  samplePlayers: number
  /** Real players' avatars wearing something earned or bought, which comes off. */
  dressedAvatars: number
  runs: number
  boardScores: number
  records: number
  ticketRows: number
  prizes: number
  trophies: number
  seasonPlayers: number
  medalsAndLaps: number
  events: number
  notifications: number
}

export type ResetPreview = {
  counts: ResetCounts
  /** When the reset stops working, ms. */
  until: number
  open: boolean
  /** When it last ran, ms, or null. */
  lastResetAt: number | null
}

/** An avatar with nothing earned or bought on it: the plain badge for a finish, no ring, only the welcome pin, nothing worn. */
function plainAvatar(avatar: Avatar): Avatar {
  return {
    ...avatar,
    badge: isFinishBadge(avatar.badge) ? 'bold' : avatar.badge,
    ring: null,
    pin: avatar.pin === 'welcome' ? 'welcome' : null,
    worn: [],
  }
}

/** The real players' avatars, each with its plain form beside it (the same string when nothing comes off). */
async function realAvatars(d: Pick<ReturnType<typeof db>, 'select'>) {
  const rows = await d
    .select({ name: nameClaims.name, avatarId: nameClaims.avatarId })
    .from(nameClaims)
    .where(and(isNotNull(nameClaims.avatarId), or(isNull(nameClaims.accountId), notLike(nameClaims.accountId, SAMPLE_ACCOUNT))))
  return rows.map((row) => {
    const avatarId = row.avatarId ?? ''
    const avatar = parseAvatar(avatarId)
    // One that doesn't parse is left as it is: nothing here knows what it wears.
    return { name: row.name, avatarId, plain: avatar ? encodeAvatar(plainAvatar(avatar)) : avatarId }
  })
}

async function countAll(): Promise<ResetCounts> {
  const rows = await db().execute(sql`
    select
      (select count(*) from accounts where coalesce(email, '') not like ${SAMPLE_EMAIL})::int as players,
      (select count(*) from launch_list)::int as launch_list,
      (select count(*) from feedback)::int as feedback,
      (select count(*) from accounts where email like ${SAMPLE_EMAIL})::int as sample_players,
      (select count(*) from game_runs)::int as runs,
      (select count(*) from leaderboard_scores)::int as board_scores,
      (select count(*) from record_scores)::int as records,
      (select count(*) from ticket_ledger)::int as ticket_rows,
      (select count(*) from prizes_owned)::int as prizes,
      (select count(*) from trophy_awards)::int as trophies,
      (select count(*) from season_progress)::int as season_players,
      ((select count(*) from course_bests) + (select count(*) from track_laps) + (select count(*) from lap_ghosts)
        + (select count(*) from day_ghosts) + (select count(*) from hole_results)
        + (select count(*) from daily_hole_results))::int as medals_and_laps,
      (select count(*) from tournaments)::int as events,
      (select count(*) from notifications)::int as notifications
  `)
  const r = (rows as unknown as Record<string, number>[])[0] ?? {}
  const dressed = (await realAvatars(db())).filter((row) => row.plain !== row.avatarId).length
  return {
    players: r.players ?? 0,
    launchList: r.launch_list ?? 0,
    feedback: r.feedback ?? 0,
    samplePlayers: r.sample_players ?? 0,
    dressedAvatars: dressed,
    runs: r.runs ?? 0,
    boardScores: r.board_scores ?? 0,
    records: r.records ?? 0,
    ticketRows: r.ticket_rows ?? 0,
    prizes: r.prizes ?? 0,
    trophies: r.trophies ?? 0,
    seasonPlayers: r.season_players ?? 0,
    medalsAndLaps: r.medals_and_laps ?? 0,
    events: r.events ?? 0,
    notifications: r.notifications ?? 0,
  }
}

let resetAtRead: Promise<number | null> | null = null

/** When the data was last reset, ms, or null if never: read once a process, as a reset restarts the API. */
export function dataResetAt(): Promise<number | null> {
  resetAtRead ??= db()
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, 'data_reset_at'))
    .limit(1)
    .then((rows) => {
      const at = rows[0] ? Date.parse(rows[0].value) : NaN
      return Number.isFinite(at) ? at : null
    })
    .catch(() => {
      resetAtRead = null
      return null
    })
  return resetAtRead
}

export async function resetPreview(now = Date.now()): Promise<ResetPreview> {
  return { counts: await countAll(), until: RESET_UNTIL, open: now < RESET_UNTIL, lastResetAt: await dataResetAt() }
}

class ResetRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

let resetting = false

/** Empty everything played and drop the sample players, in one transaction. Answers what was there before. */
export async function resetWorld(now = Date.now()): Promise<{ at: number; before: ResetCounts }> {
  if (now >= RESET_UNTIL) throw new ResetRefused('The reset was for before launch, and launch day is over.', 410, 'RESET_CLOSED')
  if (resetting) throw new ResetRefused('A reset is already running.', 409, 'RESET_RUNNING')
  resetting = true
  try {
    const before = await countAll()
    const at = new Date(now).toISOString()
    await db().transaction(async (tx) => {
      // The sample players, and what of theirs is kept by tag or by id rather than tied to their account.
      const sampleTags = tx.select({ name: nameClaims.name }).from(nameClaims).where(like(nameClaims.accountId, SAMPLE_ACCOUNT))
      await tx.delete(groupMembers).where(or(like(groupMembers.groupId, SAMPLE_ROW), inArray(groupMembers.name, sampleTags)))
      await tx.delete(groups).where(like(groups.id, SAMPLE_ROW))
      await tx
        .delete(friendships)
        .where(or(like(friendships.id, SAMPLE_ROW), like(friendships.accountIdA, SAMPLE_ACCOUNT), like(friendships.accountIdB, SAMPLE_ACCOUNT)))
      await tx
        .delete(friendRequests)
        .where(
          or(like(friendRequests.id, SAMPLE_ROW), like(friendRequests.fromAccountId, SAMPLE_ACCOUNT), like(friendRequests.toAccountId, SAMPLE_ACCOUNT)),
        )
      await tx
        .delete(directedInvites)
        .where(or(like(directedInvites.id, SAMPLE_ROW), like(directedInvites.fromAccountId, SAMPLE_ACCOUNT), inArray(directedInvites.toName, sampleTags)))
      await tx.delete(nameClaims).where(like(nameClaims.accountId, SAMPLE_ACCOUNT))
      // Their sessions, settings and the rest go with the account (on delete cascade).
      await tx.delete(accounts).where(like(accounts.email, SAMPLE_EMAIL))

      // Everything played, by everyone. The row numbers carry on, so nothing counting from one is fooled.
      await tx.execute(sql.raw(`truncate table ${PLAY_TABLES.join(', ')}`))
      // Invites to events that are gone.
      await tx.delete(directedInvites).where(eq(directedInvites.kind, 'tournament'))
      // What the avatars wore from play and the prize counter comes off them.
      for (const row of await realAvatars(tx)) {
        if (row.plain !== row.avatarId) await tx.update(nameClaims).set({ avatarId: row.plain }).where(eq(nameClaims.name, row.name))
      }
      // The trophy rounds start again from the first week and month (as seedRevision.ts clears them).
      await tx
        .insert(trophyCursor)
        .values({ id: 'default', weeklyInitialized: false, monthlyInitialized: false })
        .onConflictDoUpdate({ target: trophyCursor.id, set: { weeklyInitialized: false, monthlyInitialized: false } })
      await tx.insert(appMeta).values({ key: 'data_reset_at', value: at }).onConflictDoUpdate({ target: appMeta.key, set: { value: at } })
    })
    resetAtRead = Promise.resolve(now)
    console.log(
      `[reset] emptied play and ${before.samplePlayers} sample players at ${at}; ${before.players} accounts kept, ${before.dressedAvatars} avatars made plain`,
    )
    return { at: now, before }
  } finally {
    resetting = false
  }
}
