import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core'

/** Auth accounts. */
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  plan: text('plan').notNull(),
  googleSub: text('google_sub'),
})

export const sessions = pgTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('sessions_expires_idx').on(t.expiresAt)],
)

export const magicLinks = pgTable(
  'magic_links',
  {
    token: text('token').primaryKey(),
    email: text('email').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('magic_links_expires_idx').on(t.expiresAt)],
)

export const nameClaims = pgTable(
  'name_claims',
  {
    name: text('name').primaryKey(),
    token: text('token').notNull(),
    claimedAt: bigint('claimed_at', { mode: 'number' }).notNull(),
    accountId: text('account_id'),
    avatarId: text('avatar_id'),
  },
  (t) => [index('name_claims_account_idx').on(t.accountId)],
)

export const leaderboardScores = pgTable(
  'leaderboard_scores',
  {
    id: text('id').primaryKey(),
    game: text('game').notNull(),
    name: text('name').notNull(),
    score: integer('score').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    device: text('device').notNull(),
  },
  (t) => [
    index('lb_game_score_at_idx').on(t.game, t.score, t.at),
    index('lb_game_at_idx').on(t.game, t.at),
    index('lb_name_idx').on(t.name),
  ],
)

export const recordScores = pgTable(
  'record_scores',
  {
    id: text('id').primaryKey(),
    game: text('game').notNull(),
    recordId: text('record_id').notNull(),
    name: text('name').notNull(),
    score: integer('score').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    device: text('device').notNull(),
  },
  (t) => [
    index('rec_game_record_score_idx').on(t.game, t.recordId, t.score, t.at),
    index('rec_name_idx').on(t.name),
  ],
)

/**
 * Tournament aggregate as jsonb (players/scores/bracket nested).
 * Indexed metadata supports listing without parsing every document.
 */
export const tournaments = pgTable(
  'tournaments',
  {
    id: text('id').primaryKey(),
    data: jsonb('data').notNull(),
    official: boolean('official').notNull().default(false),
    cadence: text('cadence'),
    startsAt: bigint('starts_at', { mode: 'number' }).notNull(),
    endsAt: bigint('ends_at', { mode: 'number' }).notNull(),
    visibility: text('visibility').notNull().default('public'),
    inviteCode: text('invite_code'),
  },
  (t) => [
    index('tournaments_official_cadence_idx').on(t.official, t.cadence),
    index('tournaments_starts_idx').on(t.startsAt),
    index('tournaments_invite_idx').on(t.inviteCode),
  ],
)

export const groups = pgTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    inviteCode: text('invite_code').notNull().unique(),
    createdByAccountId: text('created_by_account_id').notNull(),
  },
  (t) => [index('groups_creator_idx').on(t.createdByAccountId)],
)

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.name] }),
    index('group_members_name_idx').on(t.name),
  ],
)

export const directedInvites = pgTable(
  'directed_invites',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    targetName: text('target_name').notNull(),
    fromAccountId: text('from_account_id').notNull(),
    fromName: text('from_name'),
    toName: text('to_name').notNull(),
    inviteCode: text('invite_code').notNull(),
    status: text('status').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('invites_to_status_idx').on(t.toName, t.status),
    index('invites_target_idx').on(t.kind, t.targetId, t.status),
  ],
)

export const trophyAwards = pgTable(
  'trophy_awards',
  {
    id: text('id').primaryKey(),
    period: text('period').notNull(),
    periodKey: integer('period_key').notNull(),
    name: text('name').notNull(),
    rank: integer('rank').notNull(),
    score: integer('score').notNull(),
    games: integer('games').notNull(),
    accountId: text('account_id'),
    awardedAt: bigint('awarded_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('trophy_name_idx').on(t.name),
    index('trophy_period_key_idx').on(t.period, t.periodKey),
  ],
)

export const trophyCursor = pgTable('trophy_cursor', {
  id: text('id').primaryKey().default('default'),
  weeklyInitialized: boolean('weekly_initialized').notNull().default(false),
  monthlyInitialized: boolean('monthly_initialized').notNull().default(false),
})

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
