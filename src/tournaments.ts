import crypto from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { tournamentPlayers, tournamentScores, tournaments as tournamentsTable } from './db/schema.js'
import { MULTI_INSTANCE, noteFeedId, onChange, onRewrite, pollNow, publish, withLease } from './feed.js'
import { fileMatchAlerts } from './matchAlerts.js'
import { planDenied, planLimits, type AccountPlan } from './plans.js'
import {
  armMatchClocks,
  bracketDrawSize,
  bracketGamesForRound,
  openMatchPairs,
  bracketHasChampion,
  earliestOpenMatchDeadline,
  bestInMatch,
  finalMatch,
  orderedMatches,
  playerNameFor,
  findOpenMatch,
  isBracketSize,
  isDoubleElimSize,
  matchAttempts,
  maybeEndWhenBracketFinished,
  maybeLockBracket,
  previewBracket,
  publicBracket,
  resolveKind,
  resolveReadyMatches,
  resolveTimedOutMatches,
  type Elimination,
  type TournamentBracket,
  type TournamentKind,
} from './bracket.js'
import { getClaim, namesOwnedByAccount, withAvatarIds } from './names.js'
import { notify, type NotificationMeta } from './notifications.js'
import { awardEventWin } from './trophies.js'
import { ALLOWED_GAMES, BOARD_TZ, canonicalizeGameSlug, isAllowedGame, resolveGameSlug, type GameSlug } from './store.js'
import { GAME_LABELS, ordinal, pts, scoreWords } from './words.js'

export type { TournamentKind } from './bracket.js'
export type { PublicBracket, PublicBracketMatch, PublicBracketSide } from './bracket.js'

/** Games eligible for rolling daily/weekly events (excludes unfinished / non-event titles). */
const EVENT_GAMES = ALLOWED_GAMES.filter((g) => g !== 'crosswalk' && g !== 'spotter')

/**
 * Games the site has retired: no new event picks one, but an event already
 * running with it keeps it, and its scores, until it ends. Simon became
 * Fireflies.
 */
const RETIRED_GAMES: ReadonlySet<GameSlug> = new Set<GameSlug>(['simon'])

export type TournamentStatus = 'upcoming' | 'active' | 'ended'
export type TournamentCadence = 'daily' | 'weekly'
export type TournamentFormat =
  | 'open'
  | 'place-points'
  | 'attempt-limited'
  | 'single-run'
  | 'cumulative'
export type TournamentScoring = 'best' | 'sum'
export type TournamentVisibility = 'public' | 'private'

export type TournamentRules = {
  maxAttempts?: number
  /** Max roster size; 0 = unlimited */
  maxPlayers?: number
  scoring?: TournamentScoring
  unlimitedDuration?: boolean
  /** Bracket only: hours each open match may be played before it auto-resolves. */
  roundPlayHours?: number
  /** Bracket only: 'double' adds a losers bracket + grand final. Default single. */
  elimination?: Elimination
  /**
   * Bracket only: the games each winners round is played on, round 1 first.
   * A round holds one or more; a bare slug is read as a round of one. Absent
   * means one game the whole way through, which is every bracket made before
   * this existed.
   */
  roundGames?: (string | string[])[]
}

export type TournamentCreator = {
  accountId: string
  email: string
  plan?: AccountPlan
}

export type TournamentPlayer = {
  id: string
  name: string
  joinedAt: number
  /**
   * Account that holds this seat.
   *
   * Joining has always required a signed-in account, but the seat never
   * recorded whose it was — which is how a seat could be carried off by
   * whoever next used the same device. Optional because seats created before
   * this existed have none; those are treated as unowned and can no longer be
   * renamed into by anyone.
   */
  accountId?: string
}

/**
 * May the account making this request carry `seat` to a new name?
 *
 * Only its owner may. The client remembers its seat id per event on the
 * device, and that alone used to be enough — so signing out and signing in as
 * someone else re-joined carrying the previous player's seat id, renaming
 * their entry and handing over their score with it.
 *
 * A seat with no owner recorded predates seats having one, and cannot be
 * carried by anybody: failing this check costs a rename its history, while
 * getting it wrong costs somebody else theirs. Those seats are stamped the
 * next time their real owner joins under their own name, which the client
 * does on load, so the unowned window is short.
 */
export function seatCarriesTo(
  seat: Pick<TournamentPlayer, 'accountId'> | undefined,
  accountId: string | undefined,
): boolean {
  if (!seat?.accountId || !accountId) return false
  return seat.accountId === accountId
}

export type TournamentScore = {
  /** Its row in tournament_scores: given when first written. */
  id?: string
  playerId: string
  game: GameSlug
  score: number
  at: number
  /** 1-based attempt index when multiple runs are stored */
  attempt?: number
  /** Bracket match this attempt belongs to */
  matchId?: string
}

export type Tournament = {
  id: string
  title: string
  blurb: string
  games: GameSlug[]
  startsAt: number
  endsAt: number
  /** Official arcade-hosted event */
  official: boolean
  /** Rolling official cadence, if any */
  cadence?: TournamentCadence | null
  format?: TournamentFormat
  /** scores = standings event; bracket = single-elim. Default scores. */
  kind?: TournamentKind
  rules?: TournamentRules
  createdBy?: TournamentCreator | null
  visibility?: TournamentVisibility
  /** Required to access private events */
  inviteCode?: string | null
  /** The host has let everyone holding a seat invite, not only themselves. */
  membersInvite?: boolean
  players: TournamentPlayer[]
  scores: TournamentScore[]
  bracket?: TournamentBracket
}

export type GameStandingRow = {
  playerId: string
  name: string
  score: number | null
  place: number | null
  points: number
}

export type StandingRow = {
  playerId: string
  name: string
  totalPoints: number
  gamesPlayed: number
  /** Place points earned per game */
  byGame: Record<
    string,
    { score: number | null; place: number | null; points: number; attemptsUsed?: number }
  >
}

/** Mario Kart–style place points (place → points). */
/** What a win on one game is worth. Last place on that game's board takes 1. */
export const TOP_PLACE_POINTS = 10

export const FORMAT_LABELS: Record<TournamentFormat, string> = {
  open: 'Open · Best score',
  'place-points': 'Place points',
  'attempt-limited': 'Limited attempts',
  'single-run': 'One run only',
  cumulative: 'Total score',
}

const MAX_COMMUNITY_DURATION_HOURS = 168
const MIN_COMMUNITY_DURATION_HOURS = 1

/**
 * Place points for one game inside an event.
 *
 * This used to be a fixed table that stopped at sixth, which is fine for a
 * family of five and wrong for everything else: in a field of thirty, the
 * other twenty-four scored nothing at all, and nothing they could do that
 * week would change it. It is a ramp now — the winner takes ten, whoever
 * comes last on that game's board takes one, and every place between them is
 * worth more than the one below.
 *
 * The field is the players who actually posted on that game, so a game half
 * the roster skipped is not scored as if they had all lost it.
 */
function placePoints(place: number | null, fieldSize: number): number {
  if (place == null || place < 1 || fieldSize < 1 || place > fieldSize) return 0
  // Winning is worth the top on its own — a straight ramp let first and
  // second tie on points once the field got big enough.
  if (place === 1) return TOP_PLACE_POINTS
  const below = Math.max(1, fieldSize - 2)
  const fromLast = fieldSize - place
  return Math.max(1, Math.round(1 + ((TOP_PLACE_POINTS - 2) * fromLast) / below))
}

type Store = { tournaments: Tournament[] }

type Ymd = { y: number; m: number; d: number; weekday: string }

export { GAME_LABELS }

function ymdInTz(ms: number, timeZone = BOARD_TZ): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    weekday: get('weekday'),
  }
}

function dateKey(y: number, m: number, d: number) {
  return y * 10_000 + m * 100 + d
}

/** Monday-start calendar key (YYYYMMDD of that Monday) in BOARD_TZ. */
function weekStartYmd(ms: number): { y: number; m: number; d: number; key: number } {
  const { y, m, d, weekday } = ymdInTz(ms)
  const sunFirst: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const daysSinceMonday = ((sunFirst[weekday] ?? 1) + 6) % 7
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - daysSinceMonday)
  const wy = dt.getUTCFullYear()
  const wm = dt.getUTCMonth() + 1
  const wd = dt.getUTCDate()
  return { y: wy, m: wm, d: wd, key: dateKey(wy, wm, wd) }
}

/** UTC ms for y-m-d hour:minute:00 in BOARD_TZ. */
function zonedDateTimeToUtc(
  y: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = BOARD_TZ,
): number {
  const utcGuess = Date.UTC(y, month - 1, day, hour, minute, 0)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    dtf
      .formatToParts(new Date(utcGuess))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return utcGuess - (asUtc - utcGuess)
}

function addCalendarDays(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickGames(seed: number, count: number): GameSlug[] {
  const rng = mulberry32(seed)
  const pool = EVENT_GAMES.filter((g) => !RETIRED_GAMES.has(g))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(count, pool.length))
}

function eventGamesReady(games: GameSlug[]) {
  return games.length > 0 && games.every((g) => (EVENT_GAMES as readonly string[]).includes(g))
}

function gameLabel(slug: GameSlug) {
  return GAME_LABELS[slug] ?? slug
}

/*
 * Normalising is idempotent, and nearly everything in this module starts by
 * doing it, so an object that has already been through it is handed back as
 * is rather than copied again. In-place edits to a normalised event keep it
 * normalised: they only ever add players and scores with canonical slugs.
 */
const normalizedTournaments = new WeakSet<Tournament>()

function normalizeTournament(t: Tournament): Tournament {
  if (normalizedTournaments.has(t)) return t
  const out = normalizeTournamentUncached(t)
  normalizedTournaments.add(out)
  return out
}

function normalizeTournamentUncached(t: Tournament): Tournament {
  let format =
    t.format ??
    (t.cadence === 'weekly' ? 'place-points' : 'open')
  const visibility = t.visibility ?? (t.createdBy && !t.official ? 'private' : 'public')
  const games = t.games
    .map((g) => resolveGameSlug(g) ?? (canonicalizeGameSlug(g) as GameSlug))
    .filter((g): g is GameSlug => isAllowedGame(g))
  const scores = (t.scores ?? []).map((s) => {
    const game = resolveGameSlug(s.game)
    return game && game !== s.game ? { ...s, game } : s
  })
  /*
   * Several games in a private event means place points across them — unless
   * it is a bracket, where several games now just means a different one each
   * round. A bracket is decided by who beat whom, so scoring it on place
   * points is both wrong and, in the UI, a confusing thing to claim.
   */
  if (
    games.length > 1 &&
    resolveKind(t) !== 'bracket' &&
    format !== 'place-points' &&
    format !== 'cumulative' &&
    (visibility === 'private' || t.createdBy)
  ) {
    format = 'place-points'
  }
  return {
    ...t,
    players: t.players ?? [],
    games: games.length > 0 ? games : t.games,
    scores,
    format,
    kind: resolveKind(t),
    rules: t.rules ?? {},
    visibility,
    createdBy: t.createdBy ?? null,
    inviteCode: t.inviteCode ?? null,
  }
}

function publicFormatLabel(t: Tournament): string {
  const normalized = normalizeTournament(t)
  if (normalized.format === 'place-points') return FORMAT_LABELS['place-points']
  if (normalized.format === 'cumulative') return FORMAT_LABELS.cumulative
  const n = normalized.rules?.maxAttempts
  if (normalized.format === 'open' || n === 0) return FORMAT_LABELS.open
  if (normalized.format === 'single-run' || n === 1) return '1 attempt per game'
  if (n) return `${n} attempts per game`
  return FORMAT_LABELS.open
}

function deriveCommunityFormat(maxAttempts: number): TournamentFormat {
  if (maxAttempts <= 0) return 'open'
  if (maxAttempts === 1) return 'single-run'
  return 'attempt-limited'
}

export function resolveFormat(t: Tournament): TournamentFormat {
  return normalizeTournament(t).format ?? 'open'
}

export function getMaxAttempts(t: Tournament): number {
  const normalized = normalizeTournament(t)
  if (resolveKind(normalized) === 'bracket') {
    const n = normalized.rules?.maxAttempts ?? 1
    return Math.max(1, Math.min(99, n))
  }
  const format = resolveFormat(normalized)
  const rulesMax = normalized.rules?.maxAttempts ?? 0
  if (format === 'open' || rulesMax <= 0) return Number.POSITIVE_INFINITY
  if (format === 'single-run') return 1
  if (format === 'attempt-limited' || format === 'place-points') {
    return Math.max(1, Math.min(99, rulesMax))
  }
  return Number.POSITIVE_INFINITY
}

export function getMaxPlayers(t: Tournament): number | null {
  const n = normalizeTournament(t).rules?.maxPlayers
  if (n == null || n <= 0) return null
  return n
}

/** True when a capped roster has no open seats (brackets lock at this point). */
export function isTournamentRosterFull(t: Tournament): boolean {
  const cap = getMaxPlayers(t)
  if (cap == null) return false
  return normalizeTournament(t).players.length >= cap
}

function playerFinishedAllGames(t: Tournament, playerId: string): boolean {
  const normalized = normalizeTournament(t)
  const format = resolveFormat(normalized)
  const maxAttempts = getMaxAttempts(normalized)
  if (format === 'open' || !Number.isFinite(maxAttempts)) return false
  for (const game of normalized.games) {
    if (playerAttempts(normalized, playerId, game) < maxAttempts) return false
  }
  return true
}

function rosterReadyForAutoEnd(t: Tournament): boolean {
  const normalized = normalizeTournament(t)
  const cap = getMaxPlayers(normalized)
  if (cap != null) return normalized.players.length >= cap
  return normalized.players.length > 0
}

function allPlayersFinishedAttempts(t: Tournament): boolean {
  const normalized = normalizeTournament(t)
  if (!rosterReadyForAutoEnd(normalized)) return false
  return normalized.players.every((p) => playerFinishedAllGames(normalized, p.id))
}

function maybeEndWhenAllFinished(t: Tournament, now: number): boolean {
  if (!allPlayersFinishedAttempts(t)) return false
  t.endsAt = now
  return true
}

/*
 * Each player's runs on each game, and the standings, worked out once per
 * change to an event rather than per question. Asking how many tries a player
 * had, or their best, was a pass over every score in the event, and the
 * standings asked it for every player on every game: at a few thousand
 * players, listing the events took seconds, and every home page lists them.
 *
 * An event's runs and roster change by push, or by a new array, so the
 * arrays and their lengths say whether what was worked out still holds.
 * Changes made inside them (a rename, a merge) bump inPlaceChanges instead.
 */
type EventIndex = {
  scores: TournamentScore[]
  scoreCount: number
  players: TournamentPlayer[]
  playerCount: number
  games: GameSlug[]
  format: TournamentFormat
  inPlace: number
  /** Player id → game → how many runs, the best, and their sum. */
  byPlayer: Map<string, Map<GameSlug, { runs: number; best: number; sum: number }>>
  standings: StandingRow[] | null
  /** The roster's tags, made on first ask. */
  names: Set<string> | null
}

const eventIndexes = new WeakMap<Tournament, EventIndex>()
/** Bumped by any change made inside an event's roster or runs rather than by adding to them. */
let inPlaceChanges = 0

function eventIndex(t: Tournament): EventIndex {
  const normalized = normalizeTournament(t)
  const format = resolveFormat(normalized)
  const hit = eventIndexes.get(normalized)
  if (
    hit &&
    hit.scores === normalized.scores &&
    hit.scoreCount === normalized.scores.length &&
    hit.players === normalized.players &&
    hit.playerCount === normalized.players.length &&
    hit.games === normalized.games &&
    hit.format === format &&
    hit.inPlace === inPlaceChanges
  ) {
    return hit
  }
  const byPlayer: EventIndex['byPlayer'] = new Map()
  for (const s of normalized.scores) {
    let games = byPlayer.get(s.playerId)
    if (!games) {
      games = new Map()
      byPlayer.set(s.playerId, games)
    }
    const row = games.get(s.game)
    if (row) {
      row.runs++
      row.sum += s.score
      if (s.score > row.best) row.best = s.score
    } else {
      games.set(s.game, { runs: 1, best: s.score, sum: s.score })
    }
  }
  const index: EventIndex = {
    scores: normalized.scores,
    scoreCount: normalized.scores.length,
    players: normalized.players,
    playerCount: normalized.players.length,
    games: normalized.games,
    format,
    inPlace: inPlaceChanges,
    byPlayer,
    standings: null,
    names: null,
  }
  eventIndexes.set(normalized, index)
  return index
}

/** Whether a tag is on an event's roster: a set look-up, not a pass over the roster. */
function hasPlayerNamed(t: Tournament, name: string): boolean {
  const index = eventIndex(t)
  index.names ??= new Set(index.players.map((p) => p.name))
  return index.names.has(name)
}

/** Each tag's place in a standings list, worked out once per list. */
const standingPlaces = new WeakMap<StandingRow[], Map<string, number>>()

/** Where a tag stands among those who have played, or -1. */
function standingIndexOf(standings: StandingRow[], name: string): number {
  let places = standingPlaces.get(standings)
  if (!places) {
    places = new Map()
    standings.forEach((row, i) => {
      if (row.gamesPlayed > 0 && !places!.has(row.name)) places!.set(row.name, i)
    })
    standingPlaces.set(standings, places)
  }
  return places.get(name) ?? -1
}

function playerAttempts(t: Tournament, playerId: string, game: GameSlug): number {
  return eventIndex(t).byPlayer.get(playerId)?.get(game)?.runs ?? 0
}

function aggregatePlayerGameScore(
  t: Tournament,
  playerId: string,
  game: GameSlug,
): number | null {
  const row = eventIndex(t).byPlayer.get(playerId)?.get(game)
  if (!row) return null
  return resolveFormat(t) === 'cumulative' ? row.sum : row.best
}

function defaultCommunityBlurb(games: GameSlug[], maxAttempts: number) {
  const labels = games.map(gameLabel).join(', ')
  if (maxAttempts <= 0) return `Community event: ${labels}. Best score wins.`
  if (maxAttempts === 1) return `One attempt per game: ${labels}.`
  return `${maxAttempts} attempts per game: ${labels}. Best score counts.`
}

export function buildDailyEvent(now = Date.now()): Tournament {
  const { y, m, d } = ymdInTz(now)
  const key = dateKey(y, m, d)
  const next = addCalendarDays(y, m, d, 1)
  const game = pickGames(key, 1)[0]!
  const label = gameLabel(game)
  return {
    id: `daily-${key}`,
    title: `Daily · ${label}`,
    blurb: `Today’s featured game is ${label}. Best score wins — join, then play from the event page.`,
    games: [game],
    startsAt: zonedDateTimeToUtc(y, m, d, 0, 0),
    endsAt: zonedDateTimeToUtc(next.y, next.m, next.d, 0, 0),
    official: true,
    cadence: 'daily',
    format: 'open',
    rules: {},
    visibility: 'public',
    createdBy: null,
    players: [],
    scores: [],
  }
}

export function buildWeeklyEvent(now = Date.now()): Tournament {
  const week = weekStartYmd(now)
  const end = addCalendarDays(week.y, week.m, week.d, 7)
  const games = pickGames(week.key * 17 + 3, 3)
  const labels = games.map(gameLabel).join(', ')
  return {
    id: `weekly-${week.key}`,
    title: 'Weekly Triple',
    blurb: `This week’s games: ${labels}. Places earn points — highest total wins.`,
    games,
    startsAt: zonedDateTimeToUtc(week.y, week.m, week.d, 0, 0),
    endsAt: zonedDateTimeToUtc(end.y, end.m, end.d, 0, 0),
    official: true,
    cadence: 'weekly',
    format: 'place-points',
    rules: {},
    visibility: 'public',
    createdBy: null,
    players: [],
    scores: [],
  }
}

/** Keep a short history of ended cadence events; drop older ones. */
function pruneCadenceHistory(store: Store): boolean {
  const keepDaily = 3
  const keepWeekly = 2
  const dailies = store.tournaments
    .filter((t) => t.cadence === 'daily')
    .sort((a, b) => b.startsAt - a.startsAt)
  const weeklies = store.tournaments
    .filter((t) => t.cadence === 'weekly')
    .sort((a, b) => b.startsAt - a.startsAt)
  const keep = new Set([
    ...dailies.slice(0, keepDaily).map((t) => t.id),
    ...weeklies.slice(0, keepWeekly).map((t) => t.id),
  ])
  const next = store.tournaments.filter((t) => {
    if (t.cadence !== 'daily' && t.cadence !== 'weekly') return true
    return keep.has(t.id)
  })
  if (next.length === store.tournaments.length) return false
  store.tournaments = next
  return true
}

function upsertRollingEvent(store: Store, next: Tournament): boolean {
  const idx = store.tournaments.findIndex((t) => t.id === next.id)
  if (idx < 0) {
    store.tournaments.push(next)
    return true
  }
  const cur = store.tournaments[idx]!
  if (eventGamesReady(cur.games)) return false
  // Rebuild if a prior seed included an unfinished game (e.g. Crosswalk).
  store.tournaments[idx] = {
    ...next,
    players: cur.players,
    scores: cur.scores.filter((s) => next.games.includes(s.game)),
  }
  return true
}

/** Ensure current daily + weekly official events exist (ET calendar). */
function ensureRollingEvents(store: Store, now = Date.now()): boolean {
  let changed = false
  if (upsertRollingEvent(store, buildDailyEvent(now))) changed = true
  if (upsertRollingEvent(store, buildWeeklyEvent(now))) changed = true
  if (pruneCadenceHistory(store)) changed = true
  return changed
}

/*
 * The day's and the week's events only change when one of them ends, so
 * there is nothing to check before then (or ten minutes, whichever is
 * sooner). Building both from the calendar on every read was a steady cost
 * on every page that lists the events.
 */
let rollingCheckAt = 0

function rollingEventsDue(store: Store, now = Date.now()): boolean {
  if (now < rollingCheckAt) return false
  const changed = ensureRollingEvents(store, now)
  const running = store.tournaments
    .filter((t) => (t.cadence === 'daily' || t.cadence === 'weekly') && t.endsAt > now)
    .map((t) => t.endsAt)
  rollingCheckAt = Math.min(now + 10 * 60_000, ...running)
  return changed
}

function emptyStore(now = Date.now()): Store {
  return { tournaments: [buildDailyEvent(now), buildWeeklyEvent(now)] }
}

/** An event's JSON: everything but its roster and runs, which have tables of their own. */
function metaOf(t: Tournament): Omit<Tournament, 'players' | 'scores'> {
  const { players: _players, scores: _scores, ...meta } = t
  return meta
}

function tournamentToRow(t: Tournament) {
  return {
    id: t.id,
    official: Boolean(t.official),
    cadence: t.cadence ?? null,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    visibility: t.visibility ?? (t.official ? 'public' : 'private'),
    inviteCode: t.inviteCode ?? null,
  }
}

/*
 * The store is every event, read once and kept: this process writes every
 * change, so the copy in memory is the truth. It used to be read again,
 * whole, every ten seconds, which cost more with every player in every event,
 * and could land between a run being added and written, dropping the run.
 * Now the database is only asked for each event's fingerprint every ten
 * seconds, and an event is read again only when something else changed it (a
 * script, a reseed) and this process isn't writing it.
 *
 * An event's roster and runs have rows of their own; its JSON holds the rest,
 * its settings and bracket. A write sends only what differs from what was
 * last written: a run posted is one row inserted. It used to be the whole
 * event, roster and runs, two megabytes at five thousand players.
 *
 * Each event is written one write at a time: a change made while its write is
 * under way goes in the next one, which carries every change made meanwhile.
 * Two writes of one event used to race, and the database could keep the older.
 *
 * With more than one server, each write also goes into the change feed in the
 * same transaction (feed.ts), and every other server puts it into its own
 * copy: the seats and runs that changed, and the event's JSON when it did. The
 * day's and the week's events take runs from every server at once, since a
 * run is a row of its own and one player's rows are only ever theirs. Any
 * other event (a bracket, a capped roster) takes one change at a time across
 * the servers, behind a lease, each server first reading the feed for the
 * change made before its turn (withEventLock).
 */
const OUTSIDE_CHECK_MS = 10_000
let eventStore: Store | null = null
let storeLoading: Promise<Store> | null = null

/** What the database holds for an event, as this process last wrote or read it. */
type Written = {
  /** The event's JSON (metaOf). */
  meta: string
  /** Each seat's row, by id. */
  players: Map<string, string>
  /** Each run's row, by id. */
  scores: Map<string, string>
  /** inPlaceChanges then: a change inside a run since means comparing every run. */
  inPlace: number
}
const written = new Map<string, Written>()
/** The database's fingerprint of each event's JSON (md5), as last written or read. */
const lastHash = new Map<string, string>()
/** Writes begun per event, so a look for outside changes can tell ours from theirs. */
const writeSeq = new Map<string, number>()
const writeSlots = new Map<string, { running: Promise<number | null> | null; next: Promise<number | null> | null }>()
const rowHash = sql<string>`md5(${tournamentsTable.data}::text)`

const SEP = '\u0001'
const playerRow = (p: TournamentPlayer) => [p.name, p.joinedAt, p.accountId ?? ''].join(SEP)
const scoreRow = (s: TournamentScore) =>
  [s.playerId, s.game, s.score, s.at, s.attempt ?? '', s.matchId ?? ''].join(SEP)

function newScoreId() {
  return `ts-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('base64url')}`
}

/** A run from before runs had rows, named for what it is, so reading it in twice keeps one. */
function legacyScoreId(tournamentId: string, s: TournamentScore) {
  const key = [tournamentId, s.playerId, s.game, s.score, s.at, s.attempt ?? '', s.matchId ?? ''].join('|')
  return `ls-${crypto.createHash('sha1').update(key).digest('base64url').slice(0, 22)}`
}

/*
 * The tables' number columns are whole numbers, and the JSON never was: the
 * world seed wrote fractional scores and times. A fraction refused by one
 * column failed the whole move of an event's runs, so every number going into
 * a row is rounded, and a run or seat missing what its row needs is left out.
 */
function whole(n: unknown): number {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? v : 0
}

function seatValues(tournamentId: string, p: TournamentPlayer): typeof tournamentPlayers.$inferInsert | null {
  if (!p || typeof p.id !== 'string' || !p.id) return null
  return {
    tournamentId,
    id: p.id,
    name: typeof p.name === 'string' && p.name ? p.name : 'PLAYER',
    joinedAt: whole(p.joinedAt),
    accountId: typeof p.accountId === 'string' && p.accountId ? p.accountId : null,
  }
}

function runValues(tournamentId: string, id: string, sc: TournamentScore): typeof tournamentScores.$inferInsert | null {
  if (!sc || typeof sc.playerId !== 'string' || !sc.playerId || typeof sc.game !== 'string' || !sc.game) return null
  return {
    id,
    tournamentId,
    playerId: sc.playerId,
    game: sc.game,
    score: whole(sc.score),
    at: whole(sc.at),
    attempt: sc.attempt == null ? null : whole(sc.attempt),
    matchId: sc.matchId == null ? null : String(sc.matchId),
  }
}

function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Put changes back in the database. A caller that changed particular events
 * names them, and only those are compared with what was written; with none
 * named (a load, a rollover, a migration), every event is.
 */
async function writeStore(store: Store, touched?: Tournament[]) {
  store.tournaments = store.tournaments.map(normalizeTournament)
  if (touched) {
    const feedIds = await Promise.all([...new Set(touched.map((t) => t.id))].map(writeEvent))
    for (const feedId of feedIds) noteFeedId(feedId)
    return
  }
  const ids = new Set(store.tournaments.map((t) => t.id))
  const gone = [...written.keys()].filter((id) => !ids.has(id))
  if (gone.length) {
    // Its roster and runs go with it (on delete cascade).
    const feedId = await db().transaction(async (tx) => {
      await tx.delete(tournamentsTable).where(inArray(tournamentsTable.id, gone))
      return publish('events-gone', { ids: gone }, tx)
    })
    noteFeedId(feedId)
    for (const id of gone) {
      written.delete(id)
      lastHash.delete(id)
    }
  }
  const feedIds = await Promise.all([...ids].map(writeEvent))
  for (const feedId of feedIds) noteFeedId(feedId)
}

/** Write one event as it stands, behind any write of it already under way: its feed number, with more than one server. */
function writeEvent(id: string): Promise<number | null> {
  let slot = writeSlots.get(id)
  if (!slot) {
    slot = { running: null, next: null }
    writeSlots.set(id, slot)
  }
  const s = slot
  const run = (): Promise<number | null> => {
    s.next = null
    const write: Promise<number | null> = writeEventNow(id).finally(() => {
      if (s.running === write) s.running = null
    })
    s.running = write
    return write
  }
  if (!s.running) return run()
  if (!s.next) s.next = s.running.then(run, run)
  return s.next
}

/** An event's change as the feed carries it: rows as written, or "read it again" when there are too many. */
type EventChange = {
  id: string
  /** The event's JSON, when it changed, and the database's fingerprint of it. */
  meta?: string
  hash?: string
  seats?: (typeof tournamentPlayers.$inferInsert)[]
  left?: string[]
  runs?: (typeof tournamentScores.$inferInsert)[]
  gone?: string[]
  reread?: boolean
}
/** More rows than this in one write (a move from the old JSON, a big merge), and the others read the event again instead. */
const FEED_ROWS_MAX = 500

async function writeEventNow(id: string): Promise<number | null> {
  const t = eventStore?.tournaments.find((x) => x.id === id)
  if (!t) return null
  const was = written.get(id) ?? { meta: '', players: new Map(), scores: new Map(), inPlace: -1 }
  const inPlaceAtStart = inPlaceChanges

  // Everything to send is worked out here, before the first await: a change
  // made while this write is under way goes in the next.
  const metaJson = JSON.stringify(metaOf(t))
  // Every seat is compared: a seat changes in place (claimed, renamed).
  const seats: { row: string; values: typeof tournamentPlayers.$inferInsert }[] = []
  const seatIds = new Set<string>()
  for (const p of t.players) {
    seatIds.add(p.id)
    const row = playerRow(p)
    if (was.players.get(p.id) === row) continue
    const values = seatValues(id, p)
    if (values) seats.push({ row, values })
  }
  const leftSeats = [...was.players.keys()].filter((pid) => !seatIds.has(pid))
  // New runs by id; every run compared only after a change made inside one (a merge).
  const everyRun = was.inPlace !== inPlaceAtStart
  const runs: { id: string; row: string; values: typeof tournamentScores.$inferInsert }[] = []
  let newRuns = 0
  for (const sc of t.scores) {
    sc.id ??= newScoreId()
    const had = was.scores.get(sc.id)
    if (had === undefined) newRuns++
    else if (!everyRun) continue
    const row = scoreRow(sc)
    if (had === row) continue
    const values = runValues(id, sc.id, sc)
    if (values) runs.push({ id: sc.id, row, values })
  }
  let goneRuns: string[] = []
  if (was.scores.size + newRuns !== t.scores.length) {
    const ids = new Set(t.scores.map((sc) => sc.id))
    goneRuns = [...was.scores.keys()].filter((sid) => !ids.has(sid))
  }
  if (metaJson === was.meta && !seats.length && !leftSeats.length && !runs.length && !goneRuns.length) return null

  writeSeq.set(id, (writeSeq.get(id) ?? 0) + 1)
  const row = tournamentToRow(t)
  let feedId: number | null = null
  const hash = await db().transaction(async (tx) => {
    let saved: string | undefined
    // The event first: its roster and runs point at it.
    if (metaJson !== was.meta) {
      const [meta] = await tx
        .insert(tournamentsTable)
        // The JSON made for the comparison, sent as it is rather than made again.
        .values({ ...row, data: sql`${metaJson}::jsonb` })
        .onConflictDoUpdate({
          target: tournamentsTable.id,
          set: {
            data: sql`excluded.data`,
            official: row.official,
            cadence: row.cadence,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            visibility: row.visibility,
            inviteCode: row.inviteCode,
          },
        })
        .returning({ hash: rowHash })
      saved = meta?.hash
    }
    for (const part of chunks(seats)) {
      await tx
        .insert(tournamentPlayers)
        .values(part.map((seat) => seat.values))
        .onConflictDoUpdate({
          target: [tournamentPlayers.tournamentId, tournamentPlayers.id],
          set: { name: sql`excluded.name`, joinedAt: sql`excluded.joined_at`, accountId: sql`excluded.account_id` },
        })
    }
    for (const part of chunks(leftSeats)) {
      await tx
        .delete(tournamentPlayers)
        .where(and(eq(tournamentPlayers.tournamentId, id), inArray(tournamentPlayers.id, part)))
    }
    for (const part of chunks(runs)) {
      await tx
        .insert(tournamentScores)
        .values(part.map((run) => run.values))
        .onConflictDoUpdate({
          target: tournamentScores.id,
          set: {
            playerId: sql`excluded.player_id`,
            game: sql`excluded.game`,
            score: sql`excluded.score`,
            at: sql`excluded.at`,
            attempt: sql`excluded.attempt`,
            matchId: sql`excluded.match_id`,
          },
        })
    }
    for (const part of chunks(goneRuns)) {
      await tx.delete(tournamentScores).where(inArray(tournamentScores.id, part))
    }
    // Last, so it lands with everything above or not at all.
    if (MULTI_INSTANCE) {
      const change: EventChange =
        seats.length + runs.length > FEED_ROWS_MAX
          ? { id, reread: true }
          : {
              id,
              ...(metaJson !== was.meta ? { meta: metaJson, ...(saved ? { hash: saved } : {}) } : {}),
              ...(seats.length ? { seats: seats.map((seat) => seat.values) } : {}),
              ...(leftSeats.length ? { left: leftSeats } : {}),
              ...(runs.length ? { runs: runs.map((run) => run.values) } : {}),
              ...(goneRuns.length ? { gone: goneRuns } : {}),
            }
      feedId = await publish('event', change, tx)
    }
    return saved
  })

  // What the database holds now.
  const now = written.get(id) ?? was
  now.meta = metaJson
  for (const seat of seats) now.players.set(seat.values.id, seat.row)
  for (const pid of leftSeats) now.players.delete(pid)
  for (const run of runs) now.scores.set(run.id, run.row)
  for (const sid of goneRuns) now.scores.delete(sid)
  now.inPlace = inPlaceAtStart
  written.set(id, now)
  if (hash) lastHash.set(id, hash)
  return feedId
}

/*
 * Another server's change to an event, put into this server's copy and into
 * what it counts as written, so its own next write doesn't send it again. The
 * event's JSON is taken in place, so a request here holding the event keeps
 * holding the one in the store. An event this server hasn't got, or a change
 * too big for the feed, is read from the tables.
 */
function applyEventChange(change: EventChange): void | Promise<void> {
  const store = eventStore
  // Not read yet: reading it will find the change in the tables.
  if (!store) return
  const id = String(change.id)
  let t = store.tournaments.find((x) => x.id === id)
  if (change.reread || (!t && !change.meta)) return rereadEvent(id)
  let was = written.get(id)
  if (!t) {
    t = normalizeTournament({ ...(JSON.parse(change.meta!) as Tournament), players: [], scores: [] })
    store.tournaments.push(t)
  }
  if (!was) {
    was = { meta: '', players: new Map(), scores: new Map(), inPlace: inPlaceChanges }
    written.set(id, was)
  }
  if (change.meta) {
    const meta = JSON.parse(change.meta) as Record<string, unknown>
    const target = t as unknown as Record<string, unknown>
    for (const key of Object.keys(target)) {
      if (key !== 'players' && key !== 'scores' && !(key in meta)) delete target[key]
    }
    Object.assign(target, meta)
    was.meta = change.meta
    if (change.hash) lastHash.set(id, change.hash)
  }
  if (change.seats?.length) {
    const byId = new Map(t.players.map((p) => [p.id, p] as const))
    for (const row of change.seats) {
      const seat: TournamentPlayer = { id: String(row.id), name: String(row.name), joinedAt: Number(row.joinedAt) }
      if (row.accountId) seat.accountId = String(row.accountId)
      const had = byId.get(seat.id)
      if (had) {
        had.name = seat.name
        had.joinedAt = seat.joinedAt
        if (seat.accountId) had.accountId = seat.accountId
        else delete had.accountId
        inPlaceChanges++
      } else {
        t.players.push(seat)
        byId.set(seat.id, seat)
      }
      was.players.set(seat.id, playerRow(seat))
    }
  }
  if (change.left?.length) {
    const left = new Set(change.left.map(String))
    t.players = t.players.filter((p) => !left.has(p.id))
    for (const pid of left) was.players.delete(pid)
  }
  if (change.runs?.length) {
    const byId = new Map(t.scores.map((sc) => [sc.id, sc] as const))
    for (const row of change.runs) {
      const run: TournamentScore = {
        id: String(row.id),
        playerId: String(row.playerId),
        game: row.game as GameSlug,
        score: Number(row.score),
        at: Number(row.at),
      }
      if (row.attempt != null) run.attempt = Number(row.attempt)
      if (row.matchId != null) run.matchId = String(row.matchId)
      const had = byId.get(run.id)
      if (had) {
        const target = had as unknown as Record<string, unknown>
        for (const key of ['attempt', 'matchId']) if (!(key in run)) delete target[key]
        Object.assign(had, run)
        inPlaceChanges++
      } else {
        t.scores.push(run)
        byId.set(run.id, run)
      }
      was.scores.set(run.id!, scoreRow(run))
    }
  }
  if (change.gone?.length) {
    const gone = new Set(change.gone.map(String))
    t.scores = t.scores.filter((sc) => !gone.has(sc.id!))
    for (const sid of gone) was.scores.delete(sid)
  }
  // Counted again at the next look, with the change in it.
  lastStandings.delete(t)
}

/** One event read again from the tables, once any write of it here is done. */
async function rereadEvent(id: string) {
  const slot = writeSlots.get(id)
  if (slot?.running || slot?.next) await (slot.next ?? slot.running)?.catch(() => {})
  const store = eventStore
  if (!store) return
  const fresh = await readEvents([id])
  if (eventStore !== store) return
  const t = fresh.events[0]
  if (t) {
    putTournament(store, t)
    lastHash.set(id, fresh.hashes.get(id)!)
  } else {
    store.tournaments = store.tournaments.filter((x) => x.id !== id)
    written.delete(id)
    lastHash.delete(id)
  }
}

onChange<EventChange>('event', (change) => applyEventChange(change))

onChange<{ ids?: string[] }>('events-gone', ({ ids }) => {
  const store = eventStore
  const gone = new Set((ids ?? []).map(String))
  if (!gone.size) return
  if (store) store.tournaments = store.tournaments.filter((t) => !gone.has(t.id))
  for (const id of gone) {
    written.delete(id)
    lastHash.delete(id)
  }
})

/** Every event read again at the next look: a script rewrote them. */
let everyEventStale = false
onRewrite('events', () => {
  everyEventStale = true
  outsideCheckedAt = 0
})

/**
 * Run a change to an event as the only server changing it, having read the
 * feed for whatever the last one did. The day's and the week's events don't
 * wait: they take runs from every server at once. With one server it simply
 * runs.
 */
async function withEventLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!MULTI_INSTANCE) return fn()
  const t = (await ensureStore()).tournaments.find((x) => x.id === id)
  if (t?.official) return fn()
  return withLease(`event:${id}`, async () => {
    await pollNow()
    return fn()
  })
}

/** An event row written the old way, its roster and runs still in its JSON. */
function carriesRows(data: unknown): boolean {
  const d = data as { players?: unknown; scores?: unknown } | null
  return Boolean(d && (Array.isArray(d.players) || Array.isArray(d.scores)))
}

/**
 * Move an old-style row's roster and runs into their tables, keeping any
 * already there (a run is named for what it is: reading it in twice keeps
 * one), then out of its JSON, unless the row changed since it was read; it is
 * read in again next time then. Every event was written this way before the
 * tables, and an older process mid-deploy, or a script, may still write one.
 */
async function moveRowsOut(row: { id: string; data: unknown; hash: string }) {
  const data = row.data as { players?: TournamentPlayer[]; scores?: TournamentScore[] }
  const players = Array.isArray(data.players) ? data.players : []
  const scores = Array.isArray(data.scores) ? data.scores : []
  await db().transaction(async (tx) => {
    const seats = players.map((p) => seatValues(row.id, p)).filter((v) => v != null)
    for (const part of chunks(seats)) {
      await tx.insert(tournamentPlayers).values(part).onConflictDoNothing()
    }
    const runs = scores
      .map((sc) => runValues(row.id, sc?.id ?? legacyScoreId(row.id, sc), sc))
      .filter((v) => v != null)
    for (const part of chunks(runs)) {
      await tx.insert(tournamentScores).values(part).onConflictDoNothing()
    }
    await tx
      .update(tournamentsTable)
      .set({ data: sql`${tournamentsTable.data} - 'players' - 'scores'` })
      .where(and(eq(tournamentsTable.id, row.id), sql`md5(${tournamentsTable.data}::text) = ${row.hash}`))
  })
}

/**
 * Events as the database holds them, each with its roster and runs, in the
 * order they came: all of them, or those named. An old-style row has its
 * roster and runs moved into their tables first.
 */
async function readEvents(ids?: string[]): Promise<{ events: Tournament[]; hashes: Map<string, string> }> {
  const select = () =>
    db().select({ id: tournamentsTable.id, data: tournamentsTable.data, hash: rowHash }).from(tournamentsTable)
  let rows = ids ? await select().where(inArray(tournamentsTable.id, ids)) : await select()
  const old = rows.filter((r) => carriesRows(r.data))
  if (old.length) {
    let moved = 0
    for (const r of old) {
      try {
        await moveRowsOut(r)
        moved++
      } catch (err) {
        console.error(`[events] moving ${r.id}'s roster and runs into their tables failed:`, err)
      }
    }
    const again = await select().where(inArray(tournamentsTable.id, old.map((r) => r.id)))
    rows = [...rows.filter((r) => !carriesRows(r.data)), ...again]
    console.log(`[events] moved the roster and runs of ${moved} of ${old.length} events into their tables`)
  }
  const players = ids
    ? await db()
        .select()
        .from(tournamentPlayers)
        .where(inArray(tournamentPlayers.tournamentId, ids))
        .orderBy(tournamentPlayers.seq)
    : await db().select().from(tournamentPlayers).orderBy(tournamentPlayers.seq)
  const scores = ids
    ? await db()
        .select()
        .from(tournamentScores)
        .where(inArray(tournamentScores.tournamentId, ids))
        .orderBy(tournamentScores.seq)
    : await db().select().from(tournamentScores).orderBy(tournamentScores.seq)
  const seatsOf = new Map<string, TournamentPlayer[]>()
  for (const p of players) {
    const seat: TournamentPlayer = { id: p.id, name: p.name, joinedAt: p.joinedAt }
    if (p.accountId) seat.accountId = p.accountId
    const list = seatsOf.get(p.tournamentId)
    if (list) list.push(seat)
    else seatsOf.set(p.tournamentId, [seat])
  }
  const runsOf = new Map<string, TournamentScore[]>()
  for (const r of scores) {
    const run: TournamentScore = { id: r.id, playerId: r.playerId, game: r.game as GameSlug, score: r.score, at: r.at }
    if (r.attempt != null) run.attempt = r.attempt
    if (r.matchId != null) run.matchId = r.matchId
    const list = runsOf.get(r.tournamentId)
    if (list) list.push(run)
    else runsOf.set(r.tournamentId, [run])
  }
  const hashes = new Map<string, string>()
  const events: Tournament[] = []
  for (const r of rows) {
    const raw = r.data as Tournament
    if (carriesRows(raw)) {
      // Still carrying its roster and runs (its move failed, or it changed as it was
      // moved): read from its JSON as before, with none of it counted as written,
      // so its next write puts it all in the tables and takes it out of the JSON.
      const t = normalizeTournament({
        ...raw,
        players: [...(seatsOf.get(r.id) ?? []), ...(Array.isArray(raw.players) ? raw.players : [])],
        scores: [...(runsOf.get(r.id) ?? []), ...(Array.isArray(raw.scores) ? raw.scores : [])],
      })
      events.push(t)
      hashes.set(r.id, r.hash)
      written.set(t.id, { meta: '', players: new Map(), scores: new Map(), inPlace: inPlaceChanges })
      continue
    }
    const t = normalizeTournament({ ...raw, players: seatsOf.get(r.id) ?? [], scores: runsOf.get(r.id) ?? [] })
    events.push(t)
    hashes.set(r.id, r.hash)
    written.set(t.id, {
      meta: JSON.stringify(metaOf(t)),
      players: new Map(t.players.map((p) => [p.id, playerRow(p)])),
      scores: new Map(t.scores.map((sc) => [sc.id!, scoreRow(sc)])),
      inPlace: inPlaceChanges,
    })
  }
  return { events, hashes }
}

async function ensureStore(now = Date.now()): Promise<Store> {
  if (!eventStore) {
    if (!storeLoading) {
      storeLoading = loadStoreFromDb(now).finally(() => {
        storeLoading = null
      })
    }
    return storeLoading
  }
  lookForOutsideChanges()
  // A day or week can tick over at any moment.
  if (rollingEventsDue(eventStore, now)) await writeStore(eventStore)
  return eventStore
}

let outsideCheckedAt = 0
let outsideChecking: Promise<void> | null = null

/** Every ten seconds, in the background: never in a request's way. */
function lookForOutsideChanges() {
  if (outsideChecking || Date.now() - outsideCheckedAt < OUTSIDE_CHECK_MS) return
  outsideCheckedAt = Date.now()
  outsideChecking = adoptOutsideChanges()
    .catch((err: unknown) => console.warn('[events] looking for outside changes failed:', err))
    .finally(() => {
      outsideChecking = null
    })
}

async function adoptOutsideChanges() {
  const store = eventStore
  if (!store) return
  const seqAtStart = new Map(writeSeq)
  // Ours to leave alone: written since the look began, or with a write under way or waiting.
  const busy = (id: string) => {
    const slot = writeSlots.get(id)
    return (
      (writeSeq.get(id) ?? 0) !== (seqAtStart.get(id) ?? 0) || Boolean(slot?.running || slot?.next)
    )
  }
  const all = everyEventStale
  everyEventStale = false
  const rows = await db().select({ id: tournamentsTable.id, hash: rowHash }).from(tournamentsTable)
  const inDb = new Set(rows.map((r) => r.id))
  const changed = rows.filter((r) => (all || lastHash.get(r.id) !== r.hash) && !busy(r.id)).map((r) => r.id)
  const gone = store.tournaments
    .filter((t) => (all || lastHash.has(t.id)) && !inDb.has(t.id) && !busy(t.id))
    .map((t) => t.id)
  if (!changed.length && !gone.length) return
  const fresh = changed.length ? await readEvents(changed) : { events: [], hashes: new Map<string, string>() }
  let took = 0
  for (const t of fresh.events) {
    if (busy(t.id)) continue
    putTournament(store, t)
    lastHash.set(t.id, fresh.hashes.get(t.id)!)
    took++
  }
  const removed = gone.filter((id) => !busy(id))
  if (removed.length) {
    store.tournaments = store.tournaments.filter((t) => !removed.includes(t.id))
    for (const id of removed) {
      written.delete(id)
      lastHash.delete(id)
    }
  }
  if (took || removed.length) {
    console.log(`[events] took in ${took} events changed and ${removed.length} removed outside this process`)
  }
}

async function loadStoreFromDb(now: number): Promise<Store> {
  written.clear()
  lastHash.clear()
  const { events, hashes } = await readEvents()
  let store: Store
  if (events.length === 0) {
    store = emptyStore(now)
    eventStore = store
    await writeStore(store)
    return store
  }
  store = { tournaments: events }
  eventStore = store
  for (const [id, hash] of hashes) lastHash.set(id, hash)
  outsideCheckedAt = Date.now()
  let migrated = false
  for (const t of store.tournaments) {
    if (t.createdBy && !t.official && t.visibility !== 'private') {
      t.visibility = 'private'
      migrated = true
    }
    if (t.visibility === 'private' && t.createdBy && !t.inviteCode) {
      t.inviteCode = generateInviteCode()
      migrated = true
    }
  }
  if (migrated) await writeStore(store)
  if (rollingEventsDue(store, now)) await writeStore(store)
  return store
}

/** Put a normalized copy back so score-array replacements persist. */
function putTournament(store: Store, t: Tournament) {
  const idx = store.tournaments.findIndex((x) => x.id === t.id)
  if (idx >= 0) store.tournaments[idx] = t
  else store.tournaments.push(t)
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateInviteCode() {
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]!
  }
  return code
}

type TournamentAccessOpts = {
  inviteCode?: string
  accountId?: string
  playerName?: string
}

function isPrivateEvent(t: Tournament): boolean {
  return normalizeTournament(t).visibility === 'private'
}

function canAccessTournament(t: Tournament, opts: TournamentAccessOpts = {}): boolean {
  const normalized = normalizeTournament(t)
  if (!isPrivateEvent(normalized)) return true
  if (opts.accountId && normalized.createdBy?.accountId === opts.accountId) return true
  const invite = opts.inviteCode?.trim().toUpperCase()
  if (invite && normalized.inviteCode?.toUpperCase() === invite) return true
  if (opts.playerName) {
    const cleaned = cleanName(opts.playerName)
    if (normalized.players.some((p) => p.name === cleaned)) return true
  }
  return false
}

function assertTournamentAccess(t: Tournament, opts: TournamentAccessOpts) {
  if (!canAccessTournament(t, opts)) {
    throw Object.assign(new Error('Valid invite required'), {
      status: 403,
      code: 'INVITE_REQUIRED',
    })
  }
}

function detailAccessOpts(
  opts?: TournamentAccessOpts & { playerName?: string; game?: string },
): TournamentAccessOpts {
  return {
    inviteCode: opts?.inviteCode,
    accountId: opts?.accountId,
    playerName: opts?.playerName,
  }
}

function syncBracketClock(t: Tournament, now: number): boolean {
  if (resolveKind(t) !== 'bracket' || !t.bracket) return false
  let changed = false
  if (armMatchClocks(t, now)) changed = true
  if (resolveReadyMatches(t, getMaxAttempts(t), false)) {
    changed = true
    if (armMatchClocks(t, now)) changed = true
  }
  if (resolveTimedOutMatches(t, getMaxAttempts(t), now)) {
    changed = true
    if (armMatchClocks(t, now)) changed = true
  }
  if (maybeEndWhenBracketFinished(t, now)) changed = true
  return changed
}

export function tournamentStatus(t: Tournament, now = Date.now()): TournamentStatus {
  const normalized = normalizeTournament(t)
  if (resolveKind(normalized) === 'bracket') {
    // Lobby stays open until the roster fills — no overall tournament timer.
    if (!normalized.bracket?.lockedAt) return 'upcoming'
    if (bracketHasChampion(normalized)) return 'ended'
    return 'active'
  }
  if (now < normalized.startsAt) return 'upcoming'
  if (allPlayersFinishedAttempts(normalized)) return 'ended'
  if (normalized.rules?.unlimitedDuration) return 'active'
  if (now > normalized.endsAt) return 'ended'
  return 'active'
}

/**
 * Who won, once there is an answer.
 *
 * A bracket is decided by its grand final — not by the highest round number,
 * which in a double draw is the losers final. A scores event is decided by the
 * standings, which are already ordered.
 */
export function tournamentWinner(
  t: Tournament,
  now = Date.now(),
  standings?: StandingRow[],
): string | null {
  const normalized = normalizeTournament(t)
  if (tournamentStatus(normalized, now) !== 'ended') return null
  if (resolveKind(normalized) === 'bracket') {
    const fin = finalMatch(normalized)
    return fin?.winnerId ? playerNameFor(normalized, fin.winnerId) : null
  }
  const [top] = standings ?? computeStandings(normalized)
  if (!top || top.gamesPlayed === 0) return null
  return top.name
}

export type PodiumEntry = {
  place: number
  name: string
  /** Total place points; the number that decides a multi-game event. */
  points: number
  /** Best raw score, for a single-game event where points say nothing. */
  score: number | null
}

/**
 * Top of the standings, for the events list.
 *
 * A bracket is decided by who beat whom, never by score: ordering its players
 * by points puts someone knocked out in round two above the runner-up. So a
 * finished draw reports its final — winner then loser — and a running one
 * reports nothing, because until it is over there is no standing to give.
 */
function publicPodium(t: Tournament, now: number, standings?: StandingRow[]): PodiumEntry[] {
  if (resolveKind(t) === 'bracket') {
    if (tournamentStatus(t, now) !== 'ended') return []
    const fin = finalMatch(t)
    if (!fin?.winnerId) return []
    const runnerUp = fin.playerIds.find((id) => id && id !== fin.winnerId) ?? null
    const seat = (id: string, place: number): PodiumEntry => ({
      place,
      name: playerNameFor(t, id),
      points: 0,
      score: bestInMatch(t, id, fin.id)?.score ?? null,
    })
    return runnerUp ? [seat(fin.winnerId, 1), seat(runnerUp, 2)] : [seat(fin.winnerId, 1)]
  }
  const podium: StandingRow[] = []
  for (const row of standings ?? computeStandings(t)) {
    if (row.gamesPlayed > 0) podium.push(row)
    if (podium.length === 3) break
  }
  return podium.map((row, i) => ({
      place: i + 1,
      name: row.name,
      points: row.totalPoints,
      score: t.games.length === 1 ? (row.byGame[t.games[0]!]?.score ?? null) : null,
    }))
}

/** Standings for an event, worked out once per request however many times they are asked for. */
function standingsMemo() {
  const memo = new Map<string, StandingRow[]>()
  return (t: Tournament): StandingRow[] => {
    let rows = memo.get(t.id)
    if (!rows) {
      rows = computeStandings(t)
      memo.set(t.id, rows)
    }
    return rows
  }
}

function publicTournament(
  t: Tournament,
  now = Date.now(),
  standingsOf: (t: Tournament) => StandingRow[] = computeStandings,
) {
  const normalized = normalizeTournament(t)
  const isPrivate = normalized.visibility === 'private'
  const bracket = resolveKind(normalized) === 'bracket'
  const standings = bracket ? [] : standingsOf(normalized)
  const nextDeadlineAt = bracket ? earliestOpenMatchDeadline(normalized) : null
  return {
    id: normalized.id,
    title: normalized.title,
    blurb: normalized.blurb,
    games: normalized.games,
    startsAt: normalized.startsAt,
    endsAt: normalized.endsAt,
    official: normalized.official,
    cadence: normalized.cadence ?? null,
    format: normalized.format!,
    formatLabel: publicFormatLabel(normalized),
    kind: resolveKind(normalized),
    rules: normalized.rules ?? {},
    private: isPrivate,
    createdBy: normalized.createdBy ? { accountId: normalized.createdBy.accountId } : null,
    visibility: normalized.visibility ?? 'public',
    status: tournamentStatus(normalized, now),
    playerCount: normalized.players.length,
    nextDeadlineAt,
    winner: tournamentWinner(normalized, now, bracket ? undefined : standings),
    podium: publicPodium(normalized, now, bracket ? undefined : standings),
    // A live bracket has no standings to show, so the card shows who is on.
    openMatches: bracket ? openMatchPairs(normalized) : [],
  }
}

/*
 * Awarded when the sweep, or anyone loading the events, finds an event over.
 * Insert is a no-op once the trophy exists, and the in-process set keeps a
 * busy list from retrying every read.
 */
const awardedEvents = new Set<string>()

/** An event's result is news for a day or so; older ones found after a restart stay unsaid. */
const RESULT_NEWS_MS = 36 * 60 * 60 * 1000

async function awardEndedEventTrophies(store: Store, now: number, only?: string) {
  const pending: Promise<unknown>[] = []
  for (const raw of store.tournaments) {
    if (only && raw.id !== only) continue
    if (awardedEvents.has(raw.id)) continue
    const t = normalizeTournament(raw)
    if (tournamentStatus(t, now) !== 'ended') continue
    const standings = computeStandings(t)
    const winner = tournamentWinner(t, now, resolveKind(t) === 'bracket' ? undefined : standings)
    if (!winner) continue
    awardedEvents.add(t.id)
    const { y, m, d } = ymdInTz(t.startsAt)
    const top = standings.find((row) => row.name === winner)
    pending.push(
      awardEventWin({
        eventId: t.id,
        eventTitle: t.title,
        periodKey: dateKey(y, m, d),
        name: winner,
        score: top?.totalPoints ?? 0,
        games: t.games.length,
        awardedAt: now,
      }).catch(() => false),
    )
    // A big field is a lot of rows to file; nobody's page load waits for them.
    if (now - t.endsAt < RESULT_NEWS_MS) {
      void tellEventResults(t, winner, standings, now).catch((err: unknown) => {
        console.warn(`[events] results for ${t.id} failed:`, err)
      })
    }
  }
  if (pending.length) await Promise.all(pending)
}

async function seatAccount(t: Tournament, playerId: string): Promise<string | null> {
  const seat = t.players.find((p) => p.id === playerId)
  if (!seat) return null
  if (seat.accountId) return seat.accountId
  return (await getClaim(seat.name))?.accountId ?? null
}

/**
 * Tell everyone who played how an event they didn't win came out. The winner
 * hears from their trophy. A daily is played by many and ends every day, so
 * only its podium hears about it.
 */
async function tellEventResults(t: Tournament, winner: string, standings: StandingRow[], now: number) {
  const href = `/tournaments/${t.id}`
  const tell = async (playerId: string, title: string, body: string, meta: NotificationMeta) => {
    const accountId = await seatAccount(t, playerId)
    if (!accountId) return
    await notify({
      accountId,
      kind: 'event-result',
      title,
      body,
      href,
      meta: { eventId: t.id, ...meta },
      digestKey: `event-result:${t.id}`,
      once: true,
      now,
    })
  }

  if (resolveKind(t) === 'bracket') {
    const fin = finalMatch(t)
    const runnerUp = fin?.playerIds.find((id) => id && id !== fin.winnerId) ?? null
    const field = t.players.length
    const order = orderedMatches(t)
    for (const seat of t.players) {
      if (seat.name === winner) continue
      if (seat.id === runnerUp) {
        await tell(seat.id, `You finished 2nd in ${t.title}`, `${winner} won the final.`, { place: 2, field })
        continue
      }
      // The last match they were in is the one that put them out.
      const last = [...order].reverse().find((m) => m.playerIds.includes(seat.id) && m.winnerId)
      if (!last || last.winnerId === seat.id) continue
      const by = playerNameFor(t, last.winnerId!)
      await tell(seat.id, `${t.title} is over`, `${winner} won it. You went out to ${by}.`, { field })
    }
    return
  }

  const field = standings.filter((row) => row.gamesPlayed > 0)
  const top = field[0]
  if (!top) return
  const single = t.games.length === 1 ? t.games[0]! : null
  const said = (row: StandingRow) => {
    if (!single) return pts(row.totalPoints)
    const score = row.byGame[single]?.score
    return score != null ? scoreWords(single, score) : pts(row.totalPoints)
  }
  for (const [i, row] of field.entries()) {
    const place = i + 1
    if (row.name === winner) continue
    if (t.cadence === 'daily' && place > 3) break
    await tell(
      row.playerId,
      `You finished ${ordinal(place)} in ${t.title}`,
      `${said(row)}, out of ${field.length} ${field.length === 1 ? 'player' : 'players'}. ${top.name} won with ${said(top)}.`,
      { place, field: field.length, ...(single ? { game: single } : {}) },
    )
  }
}

/**
 * Let time pass for events nobody is looking at: a bracket's rounds time out
 * and the next ones open, finished events hand out trophies and results, and
 * match alerts reach the players who need them. Runs on the sweep's timer and
 * after a bracket score, instead of waiting for someone to open a page.
 */
/** A bracket's clock moved as the only server changing it. */
async function syncBracketClockLocked(id: string, now: number) {
  await withEventLock(id, async () => {
    const store = await ensureStore(now)
    const raw = store.tournaments.find((x) => x.id === id)
    if (!raw) return
    const t = normalizeTournament(raw)
    if (!syncBracketClock(t, now)) return
    putTournament(store, t)
    await writeStore(store, [t])
  })
}

export async function sweepTournaments(now = Date.now(), only?: string) {
  const store = await ensureStore(now)
  const changed: Tournament[] = []
  for (const raw of [...store.tournaments]) {
    if (only && raw.id !== only) continue
    const t = normalizeTournament(raw)
    if (resolveKind(t) !== 'bracket' || !t.bracket?.lockedAt || bracketHasChampion(t)) continue
    if (MULTI_INSTANCE) {
      // Tried on a copy first: only a bracket whose clock moves waits for its turn.
      if (syncBracketClock(structuredClone(t), now)) await syncBracketClockLocked(t.id, now)
      continue
    }
    if (syncBracketClock(t, now)) {
      putTournament(store, t)
      changed.push(t)
    }
  }
  if (changed.length) await writeStore(store, changed)
  await awardEndedEventTrophies(store, now, only)
  const events = store.tournaments.map(normalizeTournament).filter((t) => !only || t.id === only)
  await fileMatchAlerts(events, now)
}

export type TournamentListFilter = 'all' | 'official' | 'mine' | 'joined'

/** Rounds a draw of this size runs. */
export function bracketRoundCount(maxPlayers: number): number {
  const size = bracketDrawSize(Math.max(2, maxPlayers))
  return Math.max(1, Math.round(Math.log2(size)))
}

export async function listTournaments(
  now = Date.now(),
  filter: TournamentListFilter = 'all',
  accountId?: string,
  playerName?: string,
) {
  const store = await ensureStore(now)
  // Match alerts are the sweep's job; a trophy is worth handing out on sight.
  await awardEndedEventTrophies(store, now)
  const cleanedPlayer = playerName ? cleanName(playerName) : ''
  const standingsOf = standingsMemo()
  let list = store.tournaments.map((t) => publicTournament(t, now, standingsOf))
  if (filter === 'official') list = list.filter((t) => t.official)
  else if (filter === 'mine') {
    if (!accountId) return []
    list = list.filter((t) => t.private && t.createdBy?.accountId === accountId)
  } else if (filter === 'joined') {
    if (!cleanedPlayer) return []
    list = store.tournaments
      .filter((t) => hasPlayerNamed(t, cleanedPlayer))
      .map((t) => publicTournament(t, now, standingsOf))
  } else {
    // "All" is everything this viewer may see: public events, plus the private
    // ones they host or already play in. Private events they have no claim to
    // stay hidden.
    list = store.tournaments
      .filter((raw) => {
        const t = normalizeTournament(raw)
        if ((t.visibility ?? 'public') !== 'private') return true
        if (accountId && t.createdBy?.accountId === accountId) return true
        if (cleanedPlayer && hasPlayerNamed(t, cleanedPlayer)) return true
        return false
      })
      .map((t) => publicTournament(t, now, standingsOf))
  }
  /*
   * Events you are in come first: one waiting on your move matters more than
   * one you have never opened. Within that, running before filling before
   * finished — and finished events run newest first, because the interesting
   * thing about a result is that it is recent, not that it is old.
   */
  const joinedIds = new Set(
    cleanedPlayer
      ? store.tournaments.filter((t) => hasPlayerNamed(t, cleanedPlayer)).map((t) => t.id)
      : [],
  )
  if (cleanedPlayer) {
    const byId = new Map(store.tournaments.map((t) => [t.id, t]))
    list = list.map((row) => {
      const joined = joinedIds.has(row.id)
      const raw = byId.get(row.id)
      if (!raw) return { ...row, joined }
      const t = normalizeTournament(raw)
      // Same reason as the podium: a bracket has no score-ranked standing.
      if (resolveKind(t) === 'bracket') return { ...row, joined }
      const standings = standingsOf(t)
      const idx = standingIndexOf(standings, cleanedPlayer)
      return idx === -1
        ? { ...row, joined }
        : { ...row, joined, yourPlace: idx + 1, yourPoints: standings[idx]!.totalPoints }
    })
  }
  return list.sort((a, b) => {
    const mine = (t: (typeof list)[number]) => (joinedIds.has(t.id) ? 0 : 1)
    const mineDiff = mine(a) - mine(b)
    if (mineDiff !== 0) return mineDiff
    const order = { active: 0, upcoming: 1, ended: 2 } as const
    const statusDiff = order[a.status] - order[b.status]
    if (statusDiff !== 0) return statusDiff
    if (a.status === 'ended' && b.status === 'ended') return b.startsAt - a.startsAt
    const cadenceRank = (c: string | null | undefined) =>
      c === 'daily' ? 0 : c === 'weekly' ? 1 : 2
    const cadenceDiff = cadenceRank(a.cadence) - cadenceRank(b.cadence)
    if (cadenceDiff !== 0) return cadenceDiff
    return a.startsAt - b.startsAt
  })
}

export async function getTournament(id: string): Promise<Tournament | null> {
  const t = (await ensureStore()).tournaments.find((x) => x.id === id)
  return t ? normalizeTournament(t) : null
}

/** Ties go to the name first in the alphabet; one collator, as localeCompare with no locale sorts. */
const nameOrder = new Intl.Collator()

/*
 * A busy event takes runs faster than its standings are worth counting: tens
 * of milliseconds each at a few thousand players, and every run changes them.
 * So an event's standings stand for half a second once counted, and runs
 * inside it share the next count. The player who just posted is never shown
 * a count from before their run (settledStandings); everyone else is at most
 * that half second behind. An event that has ended takes no runs, so its
 * standings, the ones that hand out trophies, are always exact.
 */
const EVENT_STANDINGS_SETTLE_MS = 500
const lastStandings = new WeakMap<Tournament, { at: number; rows: StandingRow[] }>()

/**
 * An event's standings, worked out once per change to it (eventIndex) and
 * shared between everyone who asks: read them, never change them.
 */
export function computeStandings(t: Tournament): StandingRow[] {
  const normalized = normalizeTournament(t)
  const index = eventIndex(normalized)
  if (index.standings) return index.standings
  const last = lastStandings.get(normalized)
  // Only while it runs: the count that decides an ended event must have every run in it.
  if (
    last &&
    Date.now() - last.at < EVENT_STANDINGS_SETTLE_MS &&
    tournamentStatus(normalized) === 'active'
  ) {
    return last.rows
  }
  const rows = countStandings(normalized, index)
  index.standings = rows
  lastStandings.set(normalized, { at: Date.now(), rows })
  return rows
}

/** Standings counted after `after`: for the player who just posted, so they see their own run. */
async function settledStandings(t: Tournament, after: number): Promise<StandingRow[]> {
  const normalized = normalizeTournament(t)
  for (let round = 0; round < 3; round++) {
    const index = eventIndex(normalized)
    if (index.standings) return index.standings
    const last = lastStandings.get(normalized)
    // Strictly after: a count in the same millisecond may have come before the run.
    if (last && last.at > after) return last.rows
    // Counted a moment ago, before this run: wait out the moment, so runs close together share one count.
    const wait = last ? EVENT_STANDINGS_SETTLE_MS - (Date.now() - last.at) : 0
    if (wait <= 0) break
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  const index = eventIndex(normalized)
  if (index.standings) return index.standings
  const rows = countStandings(normalized, index)
  index.standings = rows
  lastStandings.set(normalized, { at: Date.now(), rows })
  return rows
}

function countStandings(normalized: Tournament, index: EventIndex): StandingRow[] {
  const format = index.format
  const byGamePlaces: Record<string, Map<string, { place: number; score: number }>> = {}

  for (const game of normalized.games) {
    const aggregated = new Map<string, number>()
    for (const p of normalized.players) {
      const runs = index.byPlayer.get(p.id)?.get(game)
      if (runs) aggregated.set(p.id, format === 'cumulative' ? runs.sum : runs.best)
    }

    const ranked = [...aggregated.entries()].sort((a, b) => b[1] - a[1])
    const places = new Map<string, { place: number; score: number }>()
    let i = 0
    while (i < ranked.length) {
      let j = i + 1
      while (j < ranked.length && ranked[j][1] === ranked[i][1]) j++
      const place = i + 1
      for (let k = i; k < j; k++) {
        places.set(ranked[k][0], { place, score: ranked[k][1] })
      }
      i = j
    }
    byGamePlaces[game] = places
  }

  const rows = normalized.players.map((p) => {
    const byGame: StandingRow['byGame'] = {}
    let totalPoints = 0
    let gamesPlayed = 0
    for (const game of normalized.games) {
      const info = byGamePlaces[game]?.get(p.id)
      const place = info?.place ?? null
      const score = info?.score ?? null
      const field = byGamePlaces[game]?.size ?? 0
      const points = format === 'place-points' ? placePoints(place, field) : 0
      const attemptsUsed = index.byPlayer.get(p.id)?.get(game)?.runs ?? 0
      if (score != null) gamesPlayed += 1
      totalPoints += points
      byGame[game] = {
        score,
        place,
        points,
        ...(attemptsUsed > 0 ? { attemptsUsed } : {}),
      }
    }
    const row: StandingRow = {
      playerId: p.id,
      name: p.name,
      totalPoints,
      gamesPlayed,
      byGame,
    }
    // What breaks a tie on points: the best single score across the games, or
    // for a score event, the score itself (summed over its games).
    const scores = normalized.games.map((g) => row.byGame[g]?.score ?? 0)
    const key =
      format === 'place-points'
        ? Math.max(0, ...scores)
        : scores.reduce((sum, score) => sum + score, 0)
    return { row, key }
  })

  rows.sort((a, b) => {
    if (format === 'place-points') {
      return (
        b.row.totalPoints - a.row.totalPoints ||
        b.key - a.key ||
        b.row.gamesPlayed - a.row.gamesPlayed ||
        nameOrder.compare(a.row.name, b.row.name)
      )
    }
    return (
      b.key - a.key ||
      b.row.gamesPlayed - a.row.gamesPlayed ||
      nameOrder.compare(a.row.name, b.row.name)
    )
  })
  return rows.map(({ row }) => row)
}

export type TournamentPlayerStatus = {
  attemptsUsed: number
  maxAttempts: number | null
  attemptsRemaining: number | null
  canPlay: boolean
  best: number | null
}

export function getTournamentPlayerStatus(
  t: Tournament,
  playerName: string,
  game: GameSlug,
  now = Date.now(),
): TournamentPlayerStatus | null {
  const normalized = normalizeTournament(t)
  if (!normalized.games.includes(game)) return null
  const cleaned = cleanName(playerName)
  const player = normalized.players.find((p) => p.name === cleaned)
  const max = getMaxAttempts(normalized)
  const finiteMax = Number.isFinite(max) ? max : null
  const active = tournamentStatus(normalized, now) === 'active'

  if (resolveKind(normalized) === 'bracket') {
    if (!player) {
      return {
        attemptsUsed: 0,
        maxAttempts: finiteMax,
        attemptsRemaining: finiteMax,
        canPlay: false,
        best: null,
      }
    }
    const open = findOpenMatch(normalized, player.id)
    if (!open) {
      // No open match (won/lost/waiting) — leftover tries from a finished match don't matter.
      return {
        attemptsUsed: 0,
        maxAttempts: finiteMax,
        attemptsRemaining: 0,
        canPlay: false,
        best: null,
      }
    }
    const used = matchAttempts(normalized, player.id, open.id)
    const remaining = Math.max(0, max - used)
    const bestRow = normalized.scores
      .filter((s) => s.playerId === player.id && s.matchId === open.id)
      .reduce((m, s) => Math.max(m, s.score), 0)
    const withinRound =
      open.playEndsAt == null || now <= open.playEndsAt
    return {
      attemptsUsed: used,
      maxAttempts: finiteMax,
      attemptsRemaining: remaining,
      canPlay: active && remaining > 0 && withinRound,
      best: bestRow > 0 ? bestRow : null,
    }
  }

  if (!player) {
    return {
      attemptsUsed: 0,
      maxAttempts: finiteMax,
      attemptsRemaining: finiteMax,
      canPlay: active,
      best: null,
    }
  }
  const used = playerAttempts(normalized, player.id, game)
  const remaining = finiteMax == null ? null : Math.max(0, finiteMax - used)
  return {
    attemptsUsed: used,
    maxAttempts: finiteMax,
    attemptsRemaining: remaining,
    canPlay: active && (remaining == null || remaining > 0),
    best: aggregatePlayerGameScore(normalized, player.id, game),
  }
}

/*
 * An event's page shows its top hundred, and below them the viewer and the
 * one player its lesson is about. With thousands in an event, every row went
 * to every visitor, most of a megabyte a look. What the page says about the
 * whole field (how many played each game, who topped each, how many played
 * them all) is counted here from every row instead, once per count.
 */
const STANDINGS_TOP = 100

type StandingsSummary = {
  fieldByGame: Record<string, number>
  gameBests: { game: GameSlug; names: string[]; score: number | null }[]
  playedAll: number
  /**
   * The row the page's lesson is about, or -1: the best-placed player who won
   * a game but skipped another, behind a winner who played them all.
   */
  lessonAt: number
  /** Each tag's row. */
  rowOf: Map<string, number>
}

const standingsSummaries = new WeakMap<StandingRow[], StandingsSummary>()

function summarizeStandings(t: Tournament, rows: StandingRow[]): StandingsSummary {
  const hit = standingsSummaries.get(rows)
  if (hit) return hit
  const normalized = normalizeTournament(t)
  const games = normalized.games
  // A game's place only counts where the player scored on it.
  const placed = (row: StandingRow, game: GameSlug) => {
    const cell = row.byGame[game]
    return cell?.score != null ? (cell.place ?? null) : null
  }
  const fieldByGame: Record<string, number> = {}
  const bests = games.map((game) => ({ game, names: [] as string[], score: null as number | null }))
  for (const game of games) fieldByGame[game] = 0
  let playedAll = 0
  const rowOf = new Map<string, number>()
  rows.forEach((row, i) => {
    if (!rowOf.has(row.name)) rowOf.set(row.name, i)
    let all = true
    games.forEach((game, g) => {
      const cell = row.byGame[game]
      if (cell?.score == null) {
        all = false
        return
      }
      fieldByGame[game]++
      if (cell.place === 1) {
        bests[g]!.names.push(row.name)
        bests[g]!.score ??= cell.score
      }
    })
    if (all) playedAll++
  })
  let lessonAt = -1
  const winner = rows[0]
  if (
    resolveFormat(normalized) === 'place-points' &&
    games.length >= 2 &&
    rows.length >= 4 &&
    winner &&
    games.every((game) => placed(winner, game) != null)
  ) {
    lessonAt = rows.findIndex(
      (row, i) =>
        i > 0 &&
        games.some((game) => placed(row, game) === 1) &&
        games.some((game) => placed(row, game) == null),
    )
  }
  const summary: StandingsSummary = { fieldByGame, gameBests: bests, playedAll, lessonAt, rowOf }
  standingsSummaries.set(rows, summary)
  return summary
}

export async function getTournamentDetail(
  id: string,
  now = Date.now(),
  opts?: {
    playerName?: string
    game?: string
    inviteCode?: string
    accountId?: string
    /** A seat this device holds, so a trimmed roster still carries it under an old tag. */
    playerId?: string
    /** Asked from inside a change that holds the event's turn (withEventLock). */
    locked?: boolean
  },
) {
  const raw = await getTournament(id)
  if (!raw) return null
  let t = normalizeTournament(raw)
  if (!canAccessTournament(t, detailAccessOpts(opts))) {
    throw Object.assign(new Error('Valid invite required'), {
      status: 403,
      code: 'INVITE_REQUIRED',
    })
  }

  if (MULTI_INSTANCE && !opts?.locked) {
    // Tried on a copy first: only a bracket whose clock moves waits for its turn.
    if (resolveKind(t) === 'bracket' && syncBracketClock(structuredClone(t), now)) {
      await syncBracketClockLocked(id, now)
      t = normalizeTournament((await getTournament(id)) ?? t)
    }
  } else if (syncBracketClock(t, now)) {
    const store = await ensureStore(now)
    putTournament(store, t)
    await writeStore(store, [t])
  }

  let playerStatus: TournamentPlayerStatus | null = null
  const detailGame = opts?.game ? resolveGameSlug(opts.game) : null
  if (opts?.playerName && detailGame && t.games.includes(detailGame)) {
    playerStatus = getTournamentPlayerStatus(t, opts.playerName, detailGame, now)
  }
  const isHost = Boolean(opts?.accountId && t.createdBy?.accountId === opts.accountId)
  const canInvite = await canInviteToEvent(t, opts?.accountId)
  const rosterFull = isTournamentRosterFull(t)
  const standings = computeStandings(t)
  const summary = summarizeStandings(t, standings)
  // A bracket's seats are its story, and a small event's rows are few: those go whole.
  const whole = resolveKind(t) === 'bracket' || standings.length <= STANDINGS_TOP
  const you = opts?.playerName?.trim() ? cleanName(opts.playerName) : null
  let shown: number[]
  if (whole) {
    shown = standings.map((_, i) => i)
  } else {
    shown = Array.from({ length: STANDINGS_TOP }, (_, i) => i)
    const below = [you == null ? undefined : summary.rowOf.get(you), summary.lessonAt]
    for (const i of below) {
      if (i != null && i >= STANDINGS_TOP && !shown.includes(i)) shown.push(i)
    }
    shown.sort((a, b) => a - b)
  }
  const seats = whole
    ? t.players
    : t.players.filter((p) => p.name === you || (opts?.playerId != null && p.id === opts.playerId))
  return {
    ...publicTournament(t, now),
    // The whole roster, or for a big event the viewer's own seat.
    players: seats.map((p) => ({ id: p.id, name: p.name, joinedAt: p.joinedAt })),
    // Each row with its place in the whole field.
    standings: await withAvatarIds(shown.map((i) => ({ ...standings[i]!, place: i + 1 }))),
    standingsTotal: standings.length,
    fieldByGame: summary.fieldByGame,
    gameBests: summary.gameBests,
    playedAll: summary.playedAll,
    // The curve's ends; the places between them are spread across the field.
    placePoints: { top: TOP_PLACE_POINTS, last: 1 },
    bracket: publicBracket(t) ?? previewBracket(t),
    playerStatus,
    // Hide invite once every seat is filled — no more entries to recruit.
    inviteCode: canInvite && !rosterFull ? t.inviteCode ?? null : null,
    isHost,
    membersInvite: Boolean(t.membersInvite),
    canInvite,
  }
}

/**
 * May this account hand out the event's invite? The host always; anyone
 * holding a seat once the host has let them. The seat is found by account,
 * or by a tag the account owns, never by a tag the caller names: the code is
 * a way in.
 */
export async function canInviteToEvent(t: Tournament, accountId?: string): Promise<boolean> {
  if (!accountId) return false
  if (t.createdBy?.accountId === accountId) return true
  if (!t.membersInvite) return false
  if (t.players.some((p) => p.accountId === accountId)) return true
  const owned = new Set((await namesOwnedByAccount(accountId)).map((n) => n.name))
  return t.players.some((p) => owned.has(p.name))
}

/** The host lets everyone holding a seat invite, or takes it back. */
export async function setTournamentMembersInvite(id: string, accountId: string, on: boolean, now = Date.now()) {
  return withEventLock(id, async () => {
    const store = await ensureStore()
    const raw = store.tournaments.find((x) => x.id === id)
    if (!raw) throw Object.assign(new Error('Event not found'), { status: 404, code: 'TOURNAMENT_NOT_FOUND' })
    const t = normalizeTournament(raw)
    if (t.createdBy?.accountId !== accountId) {
      throw Object.assign(new Error('Only the host can choose who invites'), { status: 403, code: 'EVENT_FORBIDDEN' })
    }
    const next: Tournament = { ...t, membersInvite: on }
    putTournament(store, next)
    await writeStore(store, [next])
    return getTournamentDetail(id, now, { accountId, locked: true })
  })
}

export type CreateTournamentInput = {
  title: string
  blurb?: string
  games: GameSlug[]
  /** 0 = unlimited attempts per game */
  maxAttempts: number
  /** 0 = unlimited roster size */
  maxPlayers: number
  /** Scores events: overall length. Bracket: ignored (use roundPlayHours). */
  durationHours: number
  /** Bracket only: hours to play each open match. */
  roundPlayHours?: number
  /** Bracket only: 'double' adds a losers bracket. Default single. */
  elimination?: Elimination
  /** Bracket only: games per winners round, round 1 first. */
  roundGames?: (string | string[])[]
  kind?: TournamentKind
}

const MAX_PRIVATE_GAMES = 5

export async function createTournament(
  input: CreateTournamentInput,
  creator: TournamentCreator,
  now = Date.now(),
) {
  const store = await ensureStore(now)
  const plan: AccountPlan = creator.plan === 'plus' ? 'plus' : 'free'
  const limits = planLimits(plan)
  const title = input.title.trim().slice(0, 60)
  if (title.length < 3) {
    throw Object.assign(new Error('Title must be at least 3 characters'), { status: 400 })
  }

  const kind: TournamentKind = input.kind === 'bracket' ? 'bracket' : 'scores'
  const elimination: Elimination =
    kind === 'bracket' && input.elimination === 'double' ? 'double' : 'single'
  /*
   * A bracket's games are whatever its rounds are played on, so the round plan
   * is the source of truth and `games` is derived from it. Without a plan it
   * stays what it always was: the single game picked for the whole draw.
   */
  /*
   * Each round holds one or more games. A bare slug is accepted as a round of
   * one so the shape stays compatible either way.
   */
  const roundPlan: GameSlug[][] = []
  if (kind === 'bracket' && input.roundGames?.length) {
    for (const entry of input.roundGames) {
      const list = Array.isArray(entry) ? entry : [entry]
      const round: GameSlug[] = []
      for (const raw of list) {
        const slug = resolveGameSlug(raw)
        if (!slug) {
          throw Object.assign(new Error('One or more round games are not available'), {
            status: 400,
          })
        }
        if (!round.includes(slug)) round.push(slug)
      }
      if (!round.length) {
        throw Object.assign(new Error('Every round needs at least one game'), {
          status: 400,
        })
      }
      roundPlan.push(round)
    }
  }
  const games: GameSlug[] = roundPlan.length
    ? [...new Set(roundPlan.flat())]
    : [...new Set(input.games)]
  if (kind === 'bracket') {
    if (!roundPlan.length && games.length !== 1) {
      throw Object.assign(new Error('Bracket events use one game per round'), { status: 400 })
    }
    if (roundPlan.length > bracketRoundCount(input.maxPlayers)) {
      throw Object.assign(new Error('More round games than the draw has rounds'), {
        status: 400,
      })
    }
    // A losers bracket with byes strands players, so require a full draw.
    if (elimination === 'double' && !isDoubleElimSize(input.maxPlayers)) {
      throw Object.assign(
        new Error('Double elimination needs 2, 4, 8, 16, 32, or 64 players'),
        { status: 400 },
      )
    }
    if (elimination === 'double' && !limits.doubleElimination) {
      throw planDenied(
        'doubleElimination',
        plan,
        'Double elimination is a Plus feature',
      )
    }
    if (new Set(roundPlan.flat()).size > 1 && !limits.multiGameRounds) {
      throw planDenied(
        'multiGameRounds',
        plan,
        'A different game each round is a Plus feature',
      )
    }
  } else if (games.length < 1 || games.length > MAX_PRIVATE_GAMES) {
    throw Object.assign(new Error('Pick 1–5 games'), { status: 400 })
  }
  if (
    !games.every(
      (g) => isAllowedGame(g) && (EVENT_GAMES as readonly string[]).includes(g) && !RETIRED_GAMES.has(g),
    )
  ) {
    throw Object.assign(new Error('One or more games are not available for events'), { status: 400 })
  }

  const durationHours = Math.floor(input.durationHours)
  const roundPlayHours =
    input.roundPlayHours != null ? Math.floor(input.roundPlayHours) : durationHours
  if (kind === 'bracket') {
    if (
      !Number.isFinite(roundPlayHours) ||
      roundPlayHours < MIN_COMMUNITY_DURATION_HOURS ||
      roundPlayHours > MAX_COMMUNITY_DURATION_HOURS
    ) {
      throw Object.assign(new Error('Round time must be between 1 and 168 hours'), {
        status: 400,
      })
    }
  } else {
    const unlimitedDuration = durationHours <= 0
    if (
      !Number.isFinite(durationHours) ||
      (!unlimitedDuration &&
        (durationHours < MIN_COMMUNITY_DURATION_HOURS ||
          durationHours > MAX_COMMUNITY_DURATION_HOURS))
    ) {
      throw Object.assign(new Error('Duration must be between 1 and 168 hours, or unlimited'), {
        status: 400,
      })
    }
  }

  const maxAttempts = Math.max(0, Math.min(99, Math.floor(input.maxAttempts)))
  const maxPlayers = Math.max(0, Math.min(99, Math.floor(input.maxPlayers)))
  /*
   * An unlimited roster (0) is bigger than any ceiling, so it counts as over
   * the cap rather than under it.
   */
  if (maxPlayers === 0 || maxPlayers > limits.maxDraw) {
    throw planDenied(
      'maxDraw',
      plan,
      `Events of more than ${limits.maxDraw} players are a Plus feature`,
    )
  }
  if (kind === 'bracket') {
    if (!isBracketSize(maxPlayers)) {
      throw Object.assign(new Error('Bracket events need 2–64 players'), { status: 400 })
    }
    if (maxAttempts < 1) {
      throw Object.assign(new Error('Bracket events need a finite attempt limit'), { status: 400 })
    }
  } else if (maxPlayers > 0 && maxPlayers < 2) {
    throw Object.assign(new Error('Player limit must be at least 2, or unlimited'), { status: 400 })
  }
  const format =
    games.length > 1 && kind !== 'bracket'
      ? 'place-points'
      : deriveCommunityFormat(maxAttempts)

  const activeCommunity = store.tournaments.filter(
    (t) =>
      !t.official &&
      t.createdBy?.accountId === creator.accountId &&
      tournamentStatus(t, now) !== 'ended',
  )
  if (activeCommunity.length >= limits.activeEvents) {
    throw planDenied(
      'activeEvents',
      plan,
      limits.activeEvents === 1
        ? 'You already have an event running. Plus lets you run five at once.'
        : `You already have ${limits.activeEvents} active events`,
    )
  }

  const inviteCode = generateInviteCode()
  const unlimitedDuration = kind === 'bracket' || durationHours <= 0
  const endsAt = unlimitedDuration ? now : now + durationHours * 3_600_000
  const blurb =
    input.blurb?.trim().slice(0, 280) ||
    (kind === 'bracket'
      ? `${elimination === 'double' ? 'Double' : 'Single'}-elim bracket — higher score wins each match. ${
          new Set(roundPlan.flat()).size > 1
            ? `A different game each round: ${roundPlan
                .map((round) => round.map(gameLabel).join(' + '))
                .join(' → ')}.`
            : `${gameLabel(games[0]!)}.`
        }`
      : games.length > 1
        ? `Private event: ${games.map(gameLabel).join(', ')}. Place points across games — highest total wins.`
        : defaultCommunityBlurb(games, maxAttempts))
  const rules: TournamentRules = {
    maxAttempts: maxAttempts > 0 ? maxAttempts : 0,
    maxPlayers: maxPlayers > 0 ? maxPlayers : 0,
    scoring: 'best',
    ...(unlimitedDuration ? { unlimitedDuration: true } : {}),
    ...(kind === 'bracket' ? { roundPlayHours, elimination } : {}),
    ...(roundPlan.length ? { roundGames: roundPlan } : {}),
  }

  const tournament: Tournament = {
    id: `private-${uid()}`,
    title,
    blurb,
    games,
    startsAt: now,
    endsAt,
    official: false,
    cadence: null,
    format,
    kind,
    rules,
    createdBy: creator,
    visibility: 'private',
    inviteCode,
    players: [],
    scores: [],
  }

  store.tournaments.push(tournament)
  await writeStore(store, [tournament])
  return (await getTournamentDetail(tournament.id, now, { accountId: creator.accountId }))!
}

export async function joinTournament(
  id: string,
  name: string,
  now = Date.now(),
  playerId?: string | null,
  access: TournamentAccessOpts = {},
) {
  return withEventLock(id, () => joinTournamentNow(id, name, now, playerId, access))
}

async function joinTournamentNow(
  id: string,
  name: string,
  now: number,
  playerId: string | null | undefined,
  access: TournamentAccessOpts,
): Promise<{
  tournament: Awaited<ReturnType<typeof getTournamentDetail>>
  player: TournamentPlayer
}> {
  const store = await ensureStore()
  const raw = store.tournaments.find((x) => x.id === id)
  if (!raw) throw Object.assign(new Error('Tournament not found'), { status: 404 })
  const t = normalizeTournament(raw)

  const cleaned = cleanName(name)
  assertTournamentAccess(t, { ...access, playerName: cleaned })

  const status = tournamentStatus(t, now)
  if (status === 'ended') {
    throw Object.assign(new Error('Tournament has ended'), { status: 409 })
  }

  const existingByName = t.players.find((p) => p.name === cleaned)
  if (existingByName) {
    // Reaching here means assertCanUseName passed, so this really is them:
    // a good moment to stamp ownership on a seat that predates it.
    if (!existingByName.accountId && access.accountId) {
      existingByName.accountId = access.accountId
      putTournament(store, t)
      await writeStore(store, [t])
    }
    return {
      tournament: (await getTournamentDetail(id, now, {
        ...detailAccessOpts(access),
        locked: true,
        playerName: cleaned,
        accountId: access.accountId,
      }))!,
      player: existingByName,
    }
  }

  /*
   * Same seat after a gamer-tag rename: keep player id + scores.
   *
   * Only for the account that actually holds the seat. The client remembers
   * its seat id per event on the device, and that memory used to be enough on
   * its own — so signing out and signing in as someone else re-joined with the
   * previous player's seat id, and this branch quietly renamed their entry,
   * handing over their score with it. A seat nobody owns (created before seats
   * recorded an account) is no longer renameable at all: failing to a fresh
   * entry costs a rename its history, while getting it wrong costs somebody
   * else theirs.
   */
  if (playerId) {
    const seat = t.players.find((p) => p.id === playerId)
    if (seat && seatCarriesTo(seat, access.accountId)) {
      const conflict = t.players.find((p) => p.name === cleaned && p.id !== seat.id)
      if (t.bracket?.lockedAt && seat.name !== cleaned) {
        return {
          tournament: (await getTournamentDetail(id, now, {
            ...detailAccessOpts(access),
            locked: true,
            playerName: seat.name,
            accountId: access.accountId,
          }))!,
          player: seat,
        }
      }
      if (conflict) {
        mergeTournamentPlayers(t, seat, conflict)
        putTournament(store, t)
        await writeStore(store, [t])
        return {
          tournament: (await getTournamentDetail(id, now, {
            ...detailAccessOpts(access),
            locked: true,
            playerName: cleaned,
            accountId: access.accountId,
          }))!,
          player: conflict,
        }
      }
      seat.name = cleaned
      inPlaceChanges++
      putTournament(store, t)
      await writeStore(store, [t])
      return {
        tournament: (await getTournamentDetail(id, now, {
          ...detailAccessOpts(access),
          locked: true,
          playerName: cleaned,
          accountId: access.accountId,
        }))!,
        player: seat,
      }
    }
  }

  const player: TournamentPlayer = {
    id: uid(),
    name: cleaned,
    joinedAt: now,
    ...(access.accountId ? { accountId: access.accountId } : {}),
  }
  if (resolveKind(t) === 'bracket' && t.bracket?.lockedAt) {
    throw Object.assign(new Error('The bracket is already drawn'), {
      status: 409,
      code: 'BRACKET_LOCKED',
    })
  }
  const cap = getMaxPlayers(t)
  if (cap != null && t.players.length >= cap) {
    throw Object.assign(new Error('This event is full'), {
      status: 409,
      code: 'EVENT_FULL',
    })
  }
  t.players.push(player)
  maybeLockBracket(t, now)
  putTournament(store, t)
  await writeStore(store, [t])
  if (isTournamentRosterFull(t)) {
    const { revokePendingTournamentInvites } = await import('./invites.js')
    await revokePendingTournamentInvites(t.id)
  }
  return {
    tournament: (await getTournamentDetail(id, now, {
      ...detailAccessOpts(access),
      locked: true,
      playerName: cleaned,
      accountId: access.accountId,
    }))!,
    player,
  }
}

export async function submitTournamentScore(
  id: string,
  name: string,
  game: string,
  score: number,
  now = Date.now(),
  access: TournamentAccessOpts = {},
) {
  return withEventLock(id, () => submitTournamentScoreNow(id, name, game, score, now, access))
}

async function submitTournamentScoreNow(
  id: string,
  name: string,
  game: string,
  score: number,
  now: number,
  access: TournamentAccessOpts,
): Promise<{
  tournament: Awaited<ReturnType<typeof getTournamentDetail>>
  accepted: boolean
  best: number
  improved: boolean
  attemptsUsed: number
  attemptsRemaining: number | null
  maxAttempts: number | null
  youWonMatch: boolean
  youWonTournament: boolean
  matchOpponent: string | null
}> {
  const store = await ensureStore()
  const raw = store.tournaments.find((x) => x.id === id)
  if (!raw) throw Object.assign(new Error('Tournament not found'), { status: 404 })
  const t = normalizeTournament(raw)

  if (tournamentStatus(t, now) !== 'active') {
    throw Object.assign(new Error('Tournament is not active'), { status: 409 })
  }
  const gameSlug = resolveGameSlug(game)
  if (!gameSlug || !t.games.includes(gameSlug)) {
    throw Object.assign(new Error('Game not in this tournament'), { status: 400 })
  }
  if (!Number.isFinite(score) || score <= 0) {
    throw Object.assign(new Error('Invalid score'), { status: 400 })
  }

  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  assertTournamentAccess(t, { ...access, playerName: cleaned })
  let player = t.players.find((p) => p.name === cleaned)
  if (!player) {
    if (resolveKind(t) === 'bracket' && t.bracket?.lockedAt) {
      throw Object.assign(new Error('The bracket is already drawn'), {
        status: 409,
        code: 'BRACKET_LOCKED',
      })
    }
    const cap = getMaxPlayers(t)
    if (cap != null && t.players.length >= cap) {
      throw Object.assign(new Error('This event is full'), {
        status: 409,
        code: 'EVENT_FULL',
      })
    }
    player = { id: uid(), name: cleaned, joinedAt: now }
    t.players.push(player)
    maybeLockBracket(t, now)
  }

  const format = resolveFormat(t)
  const maxAttempts = getMaxAttempts(t)
  const openMatch =
    resolveKind(t) === 'bracket' ? findOpenMatch(t, player.id) : null
  if (resolveKind(t) === 'bracket') {
    if (!t.bracket?.lockedAt) {
      throw Object.assign(new Error('Bracket has not started yet'), {
        status: 409,
        code: 'BRACKET_NOT_READY',
      })
    }
    if (!openMatch) {
      throw Object.assign(new Error('It is not your match'), {
        status: 409,
        code: 'NOT_YOUR_MATCH',
      })
    }
    /*
     * Scores in a bracket are filed against the match, not the game, so
     * without this a round set to Pellets would happily accept a Snake run —
     * the match would still resolve, on a score from the wrong game.
     */
    const roundGames = bracketGamesForRound(t, openMatch.round)
    if (roundGames.length && !roundGames.includes(gameSlug)) {
      const names = roundGames
        .map((g) => {
          const slug = resolveGameSlug(g)
          return slug ? gameLabel(slug) : g
        })
        .join(' and ')
      throw Object.assign(new Error(`This round is played on ${names}`), {
        status: 409,
        code: 'WRONG_ROUND_GAME',
      })
    }
    if (openMatch.playEndsAt != null && now > openMatch.playEndsAt) {
      resolveTimedOutMatches(t, maxAttempts, now)
      armMatchClocks(t, now)
      putTournament(store, t)
      await writeStore(store, [t])
      throw Object.assign(new Error('Round time is up'), {
        status: 409,
        code: 'ROUND_EXPIRED',
      })
    }
  }

  const used =
    openMatch
      ? matchAttempts(t, player.id, openMatch.id, gameSlug)
      : playerAttempts(t, player.id, gameSlug)
  // A bracket's best counts per match; anywhere else the event's index has it.
  const prevBest = openMatch
    ? t.scores
        .filter(
          (s) => s.playerId === player.id && s.matchId === openMatch.id && s.game === gameSlug,
        )
        .reduce((max, s) => Math.max(max, s.score), 0)
    : Math.max(0, eventIndex(t).byPlayer.get(player.id)?.get(gameSlug)?.best ?? 0)

  if (format !== 'open' && used >= maxAttempts) {
    throw Object.assign(new Error('No attempts remaining'), {
      status: 409,
      code: 'ATTEMPTS_EXHAUSTED',
    })
  }

  let improved = score > prevBest

  if (format === 'open' && resolveKind(t) !== 'bracket') {
    if (score > prevBest) {
      t.scores = t.scores.filter((s) => !(s.playerId === player.id && s.game === gameSlug))
      t.scores.push({
        playerId: player.id,
        game: gameSlug,
        score,
        at: now,
      })
    } else {
      improved = false
    }
  } else {
    t.scores.push({
      playerId: player.id,
      game: gameSlug,
      score,
      at: now,
      attempt: used + 1,
      ...(openMatch ? { matchId: openMatch.id } : {}),
    })
  }

  if (resolveKind(t) === 'bracket') {
    resolveReadyMatches(t, maxAttempts, false)
    maybeEndWhenBracketFinished(t, now)
  } else {
    maybeEndWhenAllFinished(t, now)
  }
  const postedAt = Date.now()
  putTournament(store, t)
  await writeStore(store, [t])

  const attemptsUsed = format === 'open' && resolveKind(t) !== 'bracket' ? used : used + 1
  const finiteMax = Number.isFinite(maxAttempts) ? maxAttempts : null
  let attemptsRemaining =
    finiteMax == null ? null : Math.max(0, finiteMax - attemptsUsed)

  let youWonMatch = false
  let youWonTournament = false
  let matchOpponent: string | null = null
  if (resolveKind(t) === 'bracket' && openMatch) {
    const match = t.bracket?.matches.find((m) => m.id === openMatch.id)
    if (match?.winnerId) {
      // Match decided — unused attempts on this round no longer matter.
      attemptsRemaining = 0
      if (match.winnerId === player.id) youWonMatch = true
      const oppId = match.playerIds.find((pid) => pid && pid !== player.id) ?? null
      matchOpponent = oppId ? t.players.find((p) => p.id === oppId)?.name ?? null : null
    }
    if (bracketHasChampion(t)) {
      const fin = finalMatch(t)
      if (fin?.winnerId === player.id) {
        youWonTournament = true
        youWonMatch = true
        attemptsRemaining = 0
      }
    }
  }

  // The player sees the standings with this run in them.
  if (resolveKind(t) !== 'bracket') await settledStandings(t, postedAt)
  const tournament = (await getTournamentDetail(id, now, {
    ...detailAccessOpts(access),
    locked: true,
    playerName: cleaned,
    game,
    accountId: access.accountId,
  }))!
  // The run may have settled a match: clear its alerts and tell whoever is up next.
  if (resolveKind(t) === 'bracket') {
    void sweepTournaments(Date.now(), id).catch((err: unknown) => {
      console.warn(`[events] sweep after a score on ${id} failed:`, err)
    })
  }

  return {
    tournament,
    accepted: true,
    best: Math.max(prevBest, score),
    improved,
    attemptsUsed,
    attemptsRemaining,
    maxAttempts: finiteMax,
    youWonMatch,
    youWonTournament,
    matchOpponent,
  }
}

export async function activeTournamentsForGame(game: GameSlug, now = Date.now()) {
  return (await ensureStore())
    .tournaments.filter(
      (t) =>
        tournamentStatus(t, now) === 'active' &&
        t.games.includes(game) &&
        normalizeTournament(t).visibility !== 'private',
    )
    .map((t) => publicTournament(t, now))
}

function cleanName(name: string) {
  return name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
}

type TournamentRecord = Tournament

function retargetBracketIds(t: TournamentRecord, fromId: string, toId: string) {
  if (!t.bracket || fromId === toId) return
  for (const match of t.bracket.matches) {
    if (match.playerIds[0] === fromId) match.playerIds[0] = toId
    if (match.playerIds[1] === fromId) match.playerIds[1] = toId
    if (match.winnerId === fromId) match.winnerId = toId
  }
}

/** Merge `source` into `target`, then drop `source`. */
function mergeTournamentPlayers(
  t: TournamentRecord,
  source: TournamentPlayer,
  target: TournamentPlayer,
) {
  if (source.id === target.id) return
  for (const s of t.scores) {
    if (s.playerId === source.id) s.playerId = target.id
  }
  inPlaceChanges++
  retargetBracketIds(t, source.id, target.id)

  const normalized = normalizeTournament(t)
  if (resolveFormat(normalized) === 'open') {
    for (const game of t.games) {
      const rows = t.scores.filter((s) => s.playerId === target.id && s.game === game)
      if (rows.length <= 1) continue
      const best = Math.max(...rows.map((s) => s.score))
      const keep = rows.sort((a, b) => b.at - a.at).find((s) => s.score === best)!
      t.scores = t.scores.filter((s) => !(s.playerId === target.id && s.game === game))
      t.scores.push(keep)
    }
  }

  t.players = t.players.filter((p) => p.id !== source.id)
}

/**
 * Rename a guest player across all tournaments.
 * Scores stay attached (same player id). If the new name already exists
 * in a tournament, merge best scores into that player and drop the old row.
 */
export async function renamePlayerAcrossTournaments(fromRaw: string, toRaw: string): Promise<{
  from: string
  to: string
  updatedTournaments: string[]
}> {
  const from = cleanName(fromRaw)
  const to = cleanName(toRaw)
  if (from === to) return { from, to, updatedTournaments: [] }

  const store = await ensureStore()
  const updatedTournaments: string[] = []

  for (const t of store.tournaments) {
    const source = t.players.find((p) => p.name === from)
    if (!source) continue

    const target = t.players.find((p) => p.name === to)
    if (!target) {
      source.name = to
      inPlaceChanges++
      updatedTournaments.push(t.id)
      continue
    }

    // Two drawn bracket seats are opponents, not the same person.
    if (t.bracket?.lockedAt) continue

    mergeTournamentPlayers(t, source, target)
    updatedTournaments.push(t.id)
  }

  if (updatedTournaments.length) {
    await writeStore(
      store,
      store.tournaments.filter((t) => updatedTournaments.includes(t.id)),
    )
  }
  return { from, to, updatedTournaments }
}

