import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
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
    /*
     * Audit trail. All nullable: scores posted before run tokens existed have
     * none of it, and a client that never opened a run still posts while
     * REQUIRE_RUN_TOKEN is off. A null runId is not evidence of cheating — it
     * is evidence of an older client.
     */
    runId: text('run_id'),
    /** Server-measured wall time from run start to submission. */
    durationMs: bigint('duration_ms', { mode: 'number' }),
    /** Salted hash — enough to correlate runs, never the address itself. */
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('lb_game_score_at_idx').on(t.game, t.score, t.at),
    index('lb_game_at_idx').on(t.game, t.at),
    index('lb_name_idx').on(t.name),
  ],
)

/**
 * One row per game a player actually opened.
 *
 * The server cannot watch the game — it runs in the browser — but it can know
 * when the run began, because it issued the id. That turns "is this score
 * possible?" into a question with a real answer: the score is measured against
 * the time that passed on the server's own clock. Single-use, so a captured id
 * cannot be replayed.
 */
export const gameRuns = pgTable(
  'game_runs',
  {
    id: text('id').primaryKey(),
    /*
     * Null when the run was opened before signing in. A player is allowed to
     * start playing, get a good score and only then make an account — the site
     * has always worked that way — and a run that could not be opened until
     * they signed in would quietly break that. Timing is what this row is for;
     * the identity is a bonus when it happens to be known.
     */
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    game: text('game').notNull(),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    /** Set when a score consumed this run; a second attempt is rejected. */
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => [
    index('game_runs_account_idx').on(t.accountId, t.startedAt),
    index('game_runs_started_idx').on(t.startedAt),
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

/** 1:1 friend request — pending until accepted (becomes a `friendships` row) or declined/revoked. */
export const friendRequests = pgTable(
  'friend_requests',
  {
    id: text('id').primaryKey(),
    fromAccountId: text('from_account_id').notNull(),
    fromName: text('from_name'),
    toAccountId: text('to_account_id').notNull(),
    toName: text('to_name').notNull(),
    status: text('status').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('friend_requests_to_status_idx').on(t.toAccountId, t.status),
    index('friend_requests_from_status_idx').on(t.fromAccountId, t.status),
  ],
)

/** Accepted friendship. One row per pair — accountIdA/B kept in a canonical (sorted) order. */
export const friendships = pgTable(
  'friendships',
  {
    id: text('id').primaryKey(),
    accountIdA: text('account_id_a').notNull(),
    accountIdB: text('account_id_b').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('friendships_pair_idx').on(t.accountIdA, t.accountIdB),
    index('friendships_a_idx').on(t.accountIdA),
    index('friendships_b_idx').on(t.accountIdB),
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
    /** Set on event wins; null on the rolling leaderboard trophies. */
    eventId: text('event_id'),
    eventTitle: text('event_title'),
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

/**
 * Tags barred from the boards.
 *
 * Keyed by tag, but the account that held it is kept too, because banning only
 * the tag means claiming a new one and carrying on. Neither column has a
 * foreign key: a ban has to outlive the row it was written about.
 */
export const nameBans = pgTable(
  'name_bans',
  {
    name: text('name').primaryKey(),
    accountId: text('account_id'),
    reason: text('reason'),
    /** Admin email, so the record says who decided. */
    bannedBy: text('banned_by').notNull(),
    bannedAt: bigint('banned_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('name_bans_account_idx').on(t.accountId)],
)

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * In-app notification inbox.
 *
 * Everything the arcade wants to tell a player lands here; only a small subset
 * is ever also pushed to a device. `digestKey` collapses repeats — losing five
 * records in a day is one row that counts to five, not five rows.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    /** Repeat suppression: same key within a window folds into the live row. */
    digestKey: text('digest_key'),
    count: integer('count').notNull().default(1),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    readAt: bigint('read_at', { mode: 'number' }),
  },
  (t) => [
    index('notif_account_idx').on(t.accountId, t.updatedAt),
    index('notif_unread_idx').on(t.accountId, t.readAt),
    uniqueIndex('notif_digest_idx').on(t.accountId, t.digestKey),
  ],
)

/**
 * Web push endpoints, one row per device that opted in.
 *
 * Only bracket match clocks are ever delivered here — see `pushPolicy`.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** IANA zone, for holding notifications out of the middle of the night. */
    timeZone: text('time_zone'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    failedAt: bigint('failed_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('push_endpoint_idx').on(t.endpoint),
    index('push_account_idx').on(t.accountId),
  ],
)

/** Per-account delivery budget, so a bug can never turn into a flood. */
export const pushLedger = pgTable(
  'push_ledger',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** YYYYMMDD in the account's own zone. */
    dayKey: integer('day_key').notNull(),
    sent: integer('sent').notNull().default(0),
    /** Dedup: one push per match transition, ever. */
    lastKey: text('last_key'),
  },
  (t) => [uniqueIndex('push_ledger_day_idx').on(t.accountId, t.dayKey)],
)
