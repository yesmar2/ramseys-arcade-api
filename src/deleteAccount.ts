import { and, asc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { dropAccountSessions, invalidateSessionCache } from './auth.js'
import { db } from './db/client.js'
import {
  accounts,
  challengeResults,
  directedInvites,
  emailCodes,
  feedback,
  friendRequests,
  friendships,
  groupMembers,
  groups,
  launchList,
  leaderboardScores,
  magicLinks,
  memberships,
  nameClaims,
  recordScores,
  scoreFlags,
  tournamentPlayers,
  tournamentScores,
  tournaments,
  trophyAwards,
} from './db/schema.js'
import { rewrittenHere } from './feed.js'
import { invalidateFlair } from './flair.js'

/*
 * Delete my account (the site's menu, Settings). Ramsey, 2026-10-19: "can we do the "Delete my account"
 * functionality now?" It goes for good, in one transaction:
 * - The account, and with it (on delete cascade) its sign-ins, runs, tickets and prizes, season progress and
 *   Plus, laps, ghosts, holes and medals, bug hunt finds, challenges, notifications, settings and push devices.
 * - Its tags, and what they posted that's kept by tag: board scores, record book entries, trophies, flags,
 *   challenge results, events joined (with their runs) and seats in groups.
 * - Its friendships, friend requests and invites sent or to its tags, and the events it set up.
 * - Its email from the launch list, and any sign-in codes or links waiting for it.
 * Its feedback stays, with nothing saying whose it was. A group it hosts passes to the member who joined it
 * first and has an account; with nobody to take it, the group goes too. Name bans stay, so a banned tag stays
 * banned.
 *
 * An account still paying for Plus is refused until that's cancelled, so nothing goes on billing nobody.
 */

const PAYING = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete']

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

/** The tags an account holds: what the player types to confirm (none: DELETE). */
export async function accountTags(accountId: string): Promise<string[]> {
  const rows = await db().select({ name: nameClaims.name }).from(nameClaims).where(eq(nameClaims.accountId, accountId))
  return rows.map((row) => row.name)
}

/** Whether what was typed confirms deleting this account: one of its tags, or DELETE when it has none. */
export function confirmsDelete(typed: string, tags: string[]): boolean {
  const said = typed.trim().toUpperCase()
  return tags.length ? tags.some((tag) => tag.toUpperCase() === said) : said === 'DELETE'
}

export async function deleteAccount(accountId: string): Promise<{ tags: string[]; groupsPassed: number; groupsGone: number }> {
  const [account] = await db().select({ id: accounts.id, email: accounts.email }).from(accounts).where(eq(accounts.id, accountId)).limit(1)
  if (!account) throw new Refused('That account is already gone.', 404, 'ACCOUNT_NOT_FOUND')
  const [plus] = await db()
    .select({ subscription: memberships.subscription, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.accountId, accountId))
    .limit(1)
  if (plus?.subscription && PAYING.includes(plus.status)) {
    throw new Refused('You’re still paying for Plus. Cancel it first on the Plus page, then delete your account.', 409, 'PLUS_ACTIVE')
  }

  const tags = await accountTags(accountId)
  let groupsPassed = 0
  let groupsGone = 0
  await db().transaction(async (tx) => {
    const byTag = (column: AnyPgColumn) => (tags.length ? inArray(column, tags) : sql`false`)

    // Groups it hosts: to the member who joined first and has an account of their own, or gone with nobody to host.
    const hosted = await tx.select({ id: groups.id }).from(groups).where(eq(groups.createdByAccountId, accountId))
    for (const group of hosted) {
      const seats = await tx
        .select({ name: groupMembers.name })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, group.id))
        .orderBy(asc(groupMembers.joinedAt))
      const others = seats.map((seat) => seat.name).filter((name) => !tags.includes(name))
      const claims = others.length
        ? await tx
            .select({ name: nameClaims.name, accountId: nameClaims.accountId })
            .from(nameClaims)
            .where(and(inArray(nameClaims.name, others), isNotNull(nameClaims.accountId), ne(nameClaims.accountId, accountId)))
        : []
      const next = others.map((name) => claims.find((claim) => claim.name === name)).find(Boolean)
      if (next?.accountId) {
        await tx.update(groups).set({ createdByAccountId: next.accountId }).where(eq(groups.id, group.id))
        groupsPassed++
      } else {
        await tx.delete(groups).where(eq(groups.id, group.id))
        groupsGone++
      }
    }

    // What its tags posted, kept by tag rather than tied to the account.
    await tx.delete(groupMembers).where(byTag(groupMembers.name))
    await tx.delete(leaderboardScores).where(byTag(leaderboardScores.name))
    await tx.delete(recordScores).where(byTag(recordScores.name))
    await tx.delete(scoreFlags).where(byTag(scoreFlags.name))
    await tx.delete(trophyAwards).where(or(byTag(trophyAwards.name), eq(trophyAwards.accountId, accountId)))
    await tx.delete(challengeResults).where(or(byTag(challengeResults.name), eq(challengeResults.accountId, accountId)))
    const seats = tx
      .select({ id: tournamentPlayers.id })
      .from(tournamentPlayers)
      .where(or(eq(tournamentPlayers.accountId, accountId), byTag(tournamentPlayers.name)))
    await tx.delete(tournamentScores).where(inArray(tournamentScores.playerId, seats))
    await tx.delete(tournamentPlayers).where(or(eq(tournamentPlayers.accountId, accountId), byTag(tournamentPlayers.name)))
    // The events it set up (their seats and runs go with them).
    await tx.delete(tournaments).where(and(eq(tournaments.official, false), sql`${tournaments.data}->'createdBy'->>'accountId' = ${accountId}`))

    // Who it knew.
    await tx.delete(friendships).where(or(eq(friendships.accountIdA, accountId), eq(friendships.accountIdB, accountId)))
    await tx.delete(friendRequests).where(or(eq(friendRequests.fromAccountId, accountId), eq(friendRequests.toAccountId, accountId)))
    await tx.delete(directedInvites).where(or(eq(directedInvites.fromAccountId, accountId), byTag(directedInvites.toName)))

    // Its feedback stays, nobody's now; its email comes off the launch list and any sign-in waiting for it.
    await tx.update(feedback).set({ accountId: null, name: null }).where(or(eq(feedback.accountId, accountId), byTag(feedback.name)))
    await tx.delete(launchList).where(eq(launchList.email, account.email))
    await tx.delete(emailCodes).where(eq(emailCodes.email, account.email))
    await tx.delete(magicLinks).where(eq(magicLinks.email, account.email))

    // Its tags, then the account and everything tied to it.
    await tx.delete(nameClaims).where(eq(nameClaims.accountId, accountId))
    await tx.delete(accounts).where(eq(accounts.id, accountId))
  })

  // What the servers held of it: its sessions (on every server, dropAccountSessions), its tags and their boards,
  // books, events and groups.
  invalidateSessionCache()
  await dropAccountSessions(accountId)
  for (const tag of tags) invalidateFlair(tag)
  await rewrittenHere(['scores', 'records', 'events', 'claims', 'groups', 'site-records'])
  console.log(`[account] deleted an account with ${tags.length} tag(s); ${groupsPassed} group(s) passed on, ${groupsGone} gone`)
  return { tags, groupsPassed, groupsGone }
}
