import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAvatarIds } from './names.js'
import { ALLOWED_GAMES, BOARD_TZ, isAllowedGame, type GameSlug } from './store.js'

/** Games eligible for rolling daily/weekly events (excludes unfinished / non-event titles). */
const EVENT_GAMES = ALLOWED_GAMES.filter((g) => g !== 'crosswalk' && g !== 'spotter' && g !== 'stride')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'tournaments.json')

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
}

export type TournamentCreator = {
  accountId: string
  email: string
}

export type TournamentPlayer = {
  id: string
  name: string
  joinedAt: number
}

export type TournamentScore = {
  playerId: string
  game: GameSlug
  score: number
  at: number
  /** 1-based attempt index when multiple runs are stored */
  attempt?: number
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
  rules?: TournamentRules
  createdBy?: TournamentCreator | null
  visibility?: TournamentVisibility
  /** Required to access private events */
  inviteCode?: string | null
  players: TournamentPlayer[]
  scores: TournamentScore[]
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
export const PLACE_POINTS: Record<number, number> = {
  1: 10,
  2: 7,
  3: 5,
  4: 3,
  5: 2,
  6: 1,
}

export const FORMAT_LABELS: Record<TournamentFormat, string> = {
  open: 'Open · Best score',
  'place-points': 'Place points',
  'attempt-limited': 'Limited attempts',
  'single-run': 'One run only',
  cumulative: 'Total score',
}

const MAX_PRIVATE_EVENTS_PER_ACCOUNT = 5
const MAX_COMMUNITY_DURATION_HOURS = 168
const MIN_COMMUNITY_DURATION_HOURS = 1

function placePoints(place: number | null): number {
  if (place == null) return 0
  return PLACE_POINTS[place] ?? 0
}

type Store = { tournaments: Tournament[] }

type Ymd = { y: number; m: number; d: number; weekday: string }

const GAME_LABELS: Record<GameSlug, string> = {
  stacker: 'Stacker',
  patriot: 'Patriot',
  snake: 'Snake',
  pop: 'Pop',
  'dead-center': 'Dead Center',
  asteroids: 'Asteroids',
  simon: 'Simon',
  crosswalk: 'Crosswalk',
  stride: 'Stride',
  spotter: 'Spotter',
}

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
  const pool = [...EVENT_GAMES]
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

function normalizeTournament(t: Tournament): Tournament {
  let format =
    t.format ??
    (t.cadence === 'weekly' ? 'place-points' : 'open')
  const visibility = t.visibility ?? (t.createdBy && !t.official ? 'private' : 'public')
  if (
    t.games.length > 1 &&
    format !== 'place-points' &&
    format !== 'cumulative' &&
    (visibility === 'private' || t.createdBy)
  ) {
    format = 'place-points'
  }
  return {
    ...t,
    format,
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

function playerAttempts(t: Tournament, playerId: string, game: GameSlug): number {
  return t.scores.filter((s) => s.playerId === playerId && s.game === game).length
}

function aggregatePlayerGameScore(
  t: Tournament,
  playerId: string,
  game: GameSlug,
): number | null {
  const rows = t.scores.filter((s) => s.playerId === playerId && s.game === game)
  if (rows.length === 0) return null
  const format = resolveFormat(t)
  if (format === 'cumulative') return rows.reduce((sum, s) => sum + s.score, 0)
  return Math.max(...rows.map((s) => s.score))
}

function defaultCommunityBlurb(games: GameSlug[], maxAttempts: number) {
  const labels = games.map(gameLabel).join(', ')
  if (maxAttempts <= 0) return `Community event: ${labels}. Best score wins.`
  if (maxAttempts === 1) return `One attempt per game: ${labels}.`
  return `${maxAttempts} attempts per game: ${labels}. Best score counts.`
}

function buildDailyEvent(now = Date.now()): Tournament {
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

function buildWeeklyEvent(now = Date.now()): Tournament {
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

function emptyStore(now = Date.now()): Store {
  return { tournaments: [buildDailyEvent(now), buildWeeklyEvent(now)] }
}

function ensureStore(now = Date.now()): Store {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  let store: Store
  if (!fs.existsSync(STORE_PATH)) {
    store = emptyStore(now)
    writeStore(store)
    return store
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Store
    if (!Array.isArray(parsed.tournaments) || parsed.tournaments.length === 0) {
      store = emptyStore(now)
      writeStore(store)
      return store
    }
    store = { tournaments: parsed.tournaments.map(normalizeTournament) }
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
    if (migrated) writeStore(store)
  } catch {
    store = emptyStore(now)
    writeStore(store)
    return store
  }
  if (ensureRollingEvents(store, now)) writeStore(store)
  return store
}

function writeStore(store: Store) {
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, STORE_PATH)
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

export function tournamentStatus(t: Tournament, now = Date.now()): TournamentStatus {
  const normalized = normalizeTournament(t)
  if (now < normalized.startsAt) return 'upcoming'
  if (allPlayersFinishedAttempts(normalized)) return 'ended'
  if (normalized.rules?.unlimitedDuration) return 'active'
  if (now > normalized.endsAt) return 'ended'
  return 'active'
}

function publicTournament(t: Tournament, now = Date.now()) {
  const normalized = normalizeTournament(t)
  const isPrivate = normalized.visibility === 'private'
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
    rules: normalized.rules ?? {},
    private: isPrivate,
    createdBy: normalized.createdBy ? { accountId: normalized.createdBy.accountId } : null,
    visibility: normalized.visibility ?? 'public',
    status: tournamentStatus(normalized, now),
    playerCount: normalized.players.length,
  }
}

export type TournamentListFilter = 'all' | 'official' | 'mine' | 'joined'

export function listTournaments(
  now = Date.now(),
  filter: TournamentListFilter = 'all',
  accountId?: string,
  playerName?: string,
) {
  const store = ensureStore(now)
  const cleanedPlayer = playerName ? cleanName(playerName) : ''
  let list = store.tournaments.map((t) => publicTournament(t, now))
  if (filter === 'official') list = list.filter((t) => t.official)
  else if (filter === 'mine') {
    if (!accountId) return []
    list = list.filter((t) => t.private && t.createdBy?.accountId === accountId)
  } else if (filter === 'joined') {
    if (!cleanedPlayer) return []
    list = store.tournaments
      .filter((t) => normalizeTournament(t).players.some((p) => p.name === cleanedPlayer))
      .map((t) => publicTournament(t, now))
  } else {
    list = list.filter((t) => !t.private)
  }
  return list.sort((a, b) => {
    const order = { active: 0, upcoming: 1, ended: 2 } as const
    const statusDiff = order[a.status] - order[b.status]
    if (statusDiff !== 0) return statusDiff
    const cadenceRank = (c: string | null | undefined) =>
      c === 'daily' ? 0 : c === 'weekly' ? 1 : 2
    const cadenceDiff = cadenceRank(a.cadence) - cadenceRank(b.cadence)
    if (cadenceDiff !== 0) return cadenceDiff
    return a.startsAt - b.startsAt
  })
}

export function getTournament(id: string): Tournament | null {
  const t = ensureStore().tournaments.find((x) => x.id === id)
  return t ? normalizeTournament(t) : null
}

export function computeStandings(t: Tournament): StandingRow[] {
  const normalized = normalizeTournament(t)
  const byGamePlaces: Record<string, Map<string, { place: number; score: number }>> = {}

  for (const game of normalized.games) {
    const aggregated = new Map<string, number>()
    for (const p of normalized.players) {
      const score = aggregatePlayerGameScore(normalized, p.id, game)
      if (score != null) aggregated.set(p.id, score)
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

  return normalized.players
    .map((p) => {
      const byGame: StandingRow['byGame'] = {}
      let totalPoints = 0
      let gamesPlayed = 0
      for (const game of normalized.games) {
        const info = byGamePlaces[game]?.get(p.id)
        const place = info?.place ?? null
        const score = info?.score ?? null
        const points = resolveFormat(normalized) === 'place-points' ? placePoints(place) : 0
        const attemptsUsed = playerAttempts(normalized, p.id, game)
        if (score != null) gamesPlayed += 1
        totalPoints += points
        byGame[game] = {
          score,
          place,
          points,
          ...(attemptsUsed > 0 ? { attemptsUsed } : {}),
        }
      }
      return {
        playerId: p.id,
        name: p.name,
        totalPoints,
        gamesPlayed,
        byGame,
      }
    })
    .sort((a, b) => {
      const format = resolveFormat(normalized)
      if (format === 'place-points') {
        const bestScore = (row: StandingRow) =>
          Math.max(0, ...normalized.games.map((g) => row.byGame[g]?.score ?? 0))
        return (
          b.totalPoints - a.totalPoints ||
          bestScore(b) - bestScore(a) ||
          b.gamesPlayed - a.gamesPlayed ||
          a.name.localeCompare(b.name)
        )
      }
      const primaryScore = (row: StandingRow) => {
        if (normalized.games.length === 1) {
          return row.byGame[normalized.games[0]!]?.score ?? 0
        }
        return normalized.games.reduce(
          (sum, g) => sum + (row.byGame[g]?.score ?? 0),
          0,
        )
      }
      return (
        primaryScore(b) - primaryScore(a) ||
        b.gamesPlayed - a.gamesPlayed ||
        a.name.localeCompare(b.name)
      )
    })
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
  if (!player) {
    const max = getMaxAttempts(normalized)
    return {
      attemptsUsed: 0,
      maxAttempts: Number.isFinite(max) ? max : null,
      attemptsRemaining: Number.isFinite(max) ? max : null,
      canPlay: tournamentStatus(normalized, now) === 'active',
      best: null,
    }
  }
  const used = playerAttempts(normalized, player.id, game)
  const max = getMaxAttempts(normalized)
  const finiteMax = Number.isFinite(max) ? max : null
  const remaining = finiteMax == null ? null : Math.max(0, finiteMax - used)
  return {
    attemptsUsed: used,
    maxAttempts: finiteMax,
    attemptsRemaining: remaining,
    canPlay: tournamentStatus(normalized, now) === 'active' && (remaining == null || remaining > 0),
    best: aggregatePlayerGameScore(normalized, player.id, game),
  }
}

export function getTournamentDetail(
  id: string,
  now = Date.now(),
  opts?: {
    playerName?: string
    game?: string
    inviteCode?: string
    accountId?: string
  },
) {
  const raw = getTournament(id)
  if (!raw) return null
  const t = normalizeTournament(raw)
  if (!canAccessTournament(t, detailAccessOpts(opts))) {
    throw Object.assign(new Error('Valid invite required'), {
      status: 403,
      code: 'INVITE_REQUIRED',
    })
  }

  let playerStatus: TournamentPlayerStatus | null = null
  if (opts?.playerName && opts.game && isAllowedGame(opts.game) && t.games.includes(opts.game)) {
    playerStatus = getTournamentPlayerStatus(t, opts.playerName, opts.game, now)
  }
  const isHost = Boolean(opts?.accountId && t.createdBy?.accountId === opts.accountId)
  return {
    ...publicTournament(t, now),
    players: t.players.map((p) => ({ id: p.id, name: p.name, joinedAt: p.joinedAt })),
    standings: withAvatarIds(computeStandings(t)),
    placePoints: PLACE_POINTS,
    playerStatus,
    inviteCode: isHost ? t.inviteCode ?? null : null,
    isHost,
  }
}

export type CreateTournamentInput = {
  title: string
  blurb?: string
  games: GameSlug[]
  /** 0 = unlimited attempts per game */
  maxAttempts: number
  /** 0 = unlimited roster size */
  maxPlayers: number
  durationHours: number
}

const MAX_PRIVATE_GAMES = 5

export function createTournament(
  input: CreateTournamentInput,
  creator: TournamentCreator,
  now = Date.now(),
) {
  const store = ensureStore(now)
  const title = input.title.trim().slice(0, 60)
  if (title.length < 3) {
    throw Object.assign(new Error('Title must be at least 3 characters'), { status: 400 })
  }

  const games = [...new Set(input.games)]
  if (games.length < 1 || games.length > MAX_PRIVATE_GAMES) {
    throw Object.assign(new Error('Pick 1–5 games'), { status: 400 })
  }
  if (!games.every((g) => isAllowedGame(g) && (EVENT_GAMES as readonly string[]).includes(g))) {
    throw Object.assign(new Error('One or more games are not available for events'), { status: 400 })
  }

  const durationHours = Math.floor(input.durationHours)
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

  const maxAttempts = Math.max(0, Math.min(99, Math.floor(input.maxAttempts)))
  const maxPlayers = Math.max(0, Math.min(99, Math.floor(input.maxPlayers)))
  if (maxPlayers > 0 && maxPlayers < 2) {
    throw Object.assign(new Error('Player limit must be at least 2, or unlimited'), { status: 400 })
  }
  const format =
    games.length > 1 ? 'place-points' : deriveCommunityFormat(maxAttempts)

  const activeCommunity = store.tournaments.filter(
    (t) =>
      !t.official &&
      t.createdBy?.accountId === creator.accountId &&
      tournamentStatus(t, now) !== 'ended',
  )
  if (activeCommunity.length >= MAX_PRIVATE_EVENTS_PER_ACCOUNT) {
    throw Object.assign(new Error('You already have 5 active private events'), { status: 409 })
  }

  const inviteCode = generateInviteCode()
  const endsAt = unlimitedDuration ? now : now + durationHours * 3_600_000
  const blurb =
    input.blurb?.trim().slice(0, 280) ||
    (games.length > 1
      ? `Private event: ${games.map(gameLabel).join(', ')}. Place points across games — highest total wins.`
      : defaultCommunityBlurb(games, maxAttempts))
  const rules: TournamentRules = {
    maxAttempts: maxAttempts > 0 ? maxAttempts : 0,
    maxPlayers: maxPlayers > 0 ? maxPlayers : 0,
    scoring: 'best',
    ...(unlimitedDuration ? { unlimitedDuration: true } : {}),
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
    rules,
    createdBy: creator,
    visibility: 'private',
    inviteCode,
    players: [],
    scores: [],
  }

  store.tournaments.push(tournament)
  writeStore(store)
  return getTournamentDetail(tournament.id, now, { accountId: creator.accountId })!
}

export function joinTournament(
  id: string,
  name: string,
  now = Date.now(),
  playerId?: string | null,
  access: TournamentAccessOpts = {},
): { tournament: ReturnType<typeof getTournamentDetail>; player: TournamentPlayer } {
  const store = ensureStore()
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
    return {
      tournament: getTournamentDetail(id, now, {
        ...detailAccessOpts(access),
        playerName: cleaned,
        accountId: access.accountId,
      })!,
      player: existingByName,
    }
  }

  // Same device / seat after a gamer-tag rename: keep player id + scores.
  if (playerId) {
    const seat = t.players.find((p) => p.id === playerId)
    if (seat) {
      const conflict = t.players.find((p) => p.name === cleaned && p.id !== seat.id)
      if (conflict) {
        mergeTournamentPlayers(t, seat, conflict)
        writeStore(store)
        return {
          tournament: getTournamentDetail(id, now, {
            ...detailAccessOpts(access),
            playerName: cleaned,
            accountId: access.accountId,
          })!,
          player: conflict,
        }
      }
      seat.name = cleaned
      writeStore(store)
      return {
        tournament: getTournamentDetail(id, now, {
          ...detailAccessOpts(access),
          playerName: cleaned,
          accountId: access.accountId,
        })!,
        player: seat,
      }
    }
  }

  const player: TournamentPlayer = { id: uid(), name: cleaned, joinedAt: now }
  const cap = getMaxPlayers(t)
  if (cap != null && t.players.length >= cap) {
    throw Object.assign(new Error('This event is full'), {
      status: 409,
      code: 'EVENT_FULL',
    })
  }
  t.players.push(player)
  writeStore(store)
  return {
    tournament: getTournamentDetail(id, now, {
      ...detailAccessOpts(access),
      playerName: cleaned,
      accountId: access.accountId,
    })!,
    player,
  }
}

export function submitTournamentScore(
  id: string,
  name: string,
  game: string,
  score: number,
  now = Date.now(),
  access: TournamentAccessOpts = {},
): {
  tournament: ReturnType<typeof getTournamentDetail>
  accepted: boolean
  best: number
  improved: boolean
  attemptsUsed: number
  attemptsRemaining: number | null
  maxAttempts: number | null
} {
  const store = ensureStore()
  const raw = store.tournaments.find((x) => x.id === id)
  if (!raw) throw Object.assign(new Error('Tournament not found'), { status: 404 })
  const t = normalizeTournament(raw)

  if (tournamentStatus(t, now) !== 'active') {
    throw Object.assign(new Error('Tournament is not active'), { status: 409 })
  }
  if (!isAllowedGame(game) || !t.games.includes(game)) {
    throw Object.assign(new Error('Game not in this tournament'), { status: 400 })
  }
  if (!Number.isFinite(score) || score <= 0) {
    throw Object.assign(new Error('Invalid score'), { status: 400 })
  }

  const cleaned = name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
  assertTournamentAccess(t, { ...access, playerName: cleaned })
  let player = t.players.find((p) => p.name === cleaned)
  if (!player) {
    const cap = getMaxPlayers(t)
    if (cap != null && t.players.length >= cap) {
      throw Object.assign(new Error('This event is full'), {
        status: 409,
        code: 'EVENT_FULL',
      })
    }
    player = { id: uid(), name: cleaned, joinedAt: now }
    t.players.push(player)
  }

  const format = resolveFormat(t)
  const maxAttempts = getMaxAttempts(t)
  const used = playerAttempts(t, player.id, game)
  const prevBest =
    t.scores
      .filter((s) => s.playerId === player.id && s.game === game)
      .reduce((max, s) => Math.max(max, s.score), 0) || 0

  if (format !== 'open' && used >= maxAttempts) {
    throw Object.assign(new Error('No attempts remaining'), {
      status: 409,
      code: 'ATTEMPTS_EXHAUSTED',
    })
  }

  let improved = score > prevBest

  if (format === 'open') {
    if (score > prevBest) {
      t.scores = t.scores.filter((s) => !(s.playerId === player.id && s.game === game))
      t.scores.push({
        playerId: player.id,
        game,
        score,
        at: now,
      })
      writeStore(store)
    } else {
      improved = false
    }
  } else {
    t.scores.push({
      playerId: player.id,
      game,
      score,
      at: now,
      attempt: used + 1,
    })
    writeStore(store)
  }

  maybeEndWhenAllFinished(t, now)
  writeStore(store)

  const attemptsUsed = format === 'open' ? used : used + 1
  const finiteMax = Number.isFinite(maxAttempts) ? maxAttempts : null
  const attemptsRemaining =
    finiteMax == null ? null : Math.max(0, finiteMax - attemptsUsed)

  return {
    tournament: getTournamentDetail(id, now, {
      ...detailAccessOpts(access),
      playerName: cleaned,
      game,
      accountId: access.accountId,
    })!,
    accepted: true,
    best: Math.max(prevBest, score),
    improved,
    attemptsUsed,
    attemptsRemaining,
    maxAttempts: finiteMax,
  }
}

export function activeTournamentsForGame(game: GameSlug, now = Date.now()) {
  return ensureStore()
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
export function renamePlayerAcrossTournaments(fromRaw: string, toRaw: string): {
  from: string
  to: string
  updatedTournaments: string[]
} {
  const from = cleanName(fromRaw)
  const to = cleanName(toRaw)
  if (from === to) return { from, to, updatedTournaments: [] }

  const store = ensureStore()
  const updatedTournaments: string[] = []

  for (const t of store.tournaments) {
    const source = t.players.find((p) => p.name === from)
    if (!source) continue

    const target = t.players.find((p) => p.name === to)
    if (!target) {
      source.name = to
      updatedTournaments.push(t.id)
      continue
    }

    mergeTournamentPlayers(t, source, target)
    updatedTournaments.push(t.id)
  }

  if (updatedTournaments.length) writeStore(store)
  return { from, to, updatedTournaments }
}

