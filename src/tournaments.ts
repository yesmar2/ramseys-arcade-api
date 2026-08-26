import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAvatarIds } from './names.js'
import { ALLOWED_GAMES, BOARD_TZ, isAllowedGame, type GameSlug } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'tournaments.json')

export type TournamentStatus = 'upcoming' | 'active' | 'ended'
export type TournamentCadence = 'daily' | 'weekly'

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
  byGame: Record<string, { score: number | null; place: number | null; points: number }>
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
  const pool = [...ALLOWED_GAMES]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(count, pool.length))
}

function gameLabel(slug: GameSlug) {
  return GAME_LABELS[slug] ?? slug
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

/** Ensure current daily + weekly official events exist (ET calendar). */
function ensureRollingEvents(store: Store, now = Date.now()): boolean {
  let changed = false
  const daily = buildDailyEvent(now)
  if (!store.tournaments.some((t) => t.id === daily.id)) {
    store.tournaments.push(daily)
    changed = true
  }
  const weekly = buildWeeklyEvent(now)
  if (!store.tournaments.some((t) => t.id === weekly.id)) {
    store.tournaments.push(weekly)
    changed = true
  }
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
    store = { tournaments: parsed.tournaments }
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

export function tournamentStatus(t: Tournament, now = Date.now()): TournamentStatus {
  if (now < t.startsAt) return 'upcoming'
  if (now > t.endsAt) return 'ended'
  return 'active'
}

function publicTournament(t: Tournament, now = Date.now()) {
  return {
    id: t.id,
    title: t.title,
    blurb: t.blurb,
    games: t.games,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    official: t.official,
    cadence: t.cadence ?? null,
    status: tournamentStatus(t, now),
    playerCount: t.players.length,
  }
}

export function listTournaments(now = Date.now()) {
  const store = ensureStore(now)
  return store.tournaments
    .map((t) => publicTournament(t, now))
    .sort((a, b) => {
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
  return ensureStore().tournaments.find((t) => t.id === id) ?? null
}

export function computeStandings(t: Tournament): StandingRow[] {
  const byGamePlaces: Record<string, Map<string, { place: number; score: number }>> = {}

  for (const game of t.games) {
    const best = new Map<string, number>()
    for (const s of t.scores) {
      if (s.game !== game) continue
      const prev = best.get(s.playerId)
      if (prev == null || s.score > prev) best.set(s.playerId, s.score)
    }

    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1])
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

  return t.players
    .map((p) => {
      const byGame: StandingRow['byGame'] = {}
      let totalPoints = 0
      let gamesPlayed = 0
      for (const game of t.games) {
        const info = byGamePlaces[game]?.get(p.id)
        const place = info?.place ?? null
        const score = info?.score ?? null
        const points = placePoints(place)
        if (score != null) gamesPlayed += 1
        totalPoints += points
        byGame[game] = { score, place, points }
      }
      return {
        playerId: p.id,
        name: p.name,
        totalPoints,
        gamesPlayed,
        byGame,
      }
    })
    .sort(
      (a, b) => {
        const bestScore = (row: StandingRow) =>
          Math.max(0, ...t.games.map((g) => row.byGame[g]?.score ?? 0))
        return (
          b.totalPoints - a.totalPoints ||
          bestScore(b) - bestScore(a) ||
          b.gamesPlayed - a.gamesPlayed ||
          a.name.localeCompare(b.name)
        )
      },
    )
}

export function getTournamentDetail(id: string, now = Date.now()) {
  const t = getTournament(id)
  if (!t) return null
  return {
    ...publicTournament(t, now),
    players: t.players.map((p) => ({ id: p.id, name: p.name, joinedAt: p.joinedAt })),
    standings: withAvatarIds(computeStandings(t)),
    placePoints: PLACE_POINTS,
  }
}

export function joinTournament(
  id: string,
  name: string,
  now = Date.now(),
  playerId?: string | null,
): { tournament: ReturnType<typeof getTournamentDetail>; player: TournamentPlayer } {
  const store = ensureStore()
  const t = store.tournaments.find((x) => x.id === id)
  if (!t) throw Object.assign(new Error('Tournament not found'), { status: 404 })

  const status = tournamentStatus(t, now)
  if (status === 'ended') {
    throw Object.assign(new Error('Tournament has ended'), { status: 409 })
  }

  const cleaned = cleanName(name)
  const existingByName = t.players.find((p) => p.name === cleaned)
  if (existingByName) {
    return { tournament: getTournamentDetail(id, now)!, player: existingByName }
  }

  // Same device / seat after a gamer-tag rename: keep player id + scores.
  if (playerId) {
    const seat = t.players.find((p) => p.id === playerId)
    if (seat) {
      const conflict = t.players.find((p) => p.name === cleaned && p.id !== seat.id)
      if (conflict) {
        mergeTournamentPlayers(t, seat, conflict)
        writeStore(store)
        return { tournament: getTournamentDetail(id, now)!, player: conflict }
      }
      seat.name = cleaned
      writeStore(store)
      return { tournament: getTournamentDetail(id, now)!, player: seat }
    }
  }

  const player: TournamentPlayer = { id: uid(), name: cleaned, joinedAt: now }
  t.players.push(player)
  writeStore(store)
  return { tournament: getTournamentDetail(id, now)!, player }
}

export function submitTournamentScore(
  id: string,
  name: string,
  game: string,
  score: number,
  now = Date.now(),
): {
  tournament: ReturnType<typeof getTournamentDetail>
  accepted: boolean
  best: number
  improved: boolean
} {
  const store = ensureStore()
  const t = store.tournaments.find((x) => x.id === id)
  if (!t) throw Object.assign(new Error('Tournament not found'), { status: 404 })

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
  let player = t.players.find((p) => p.name === cleaned)
  if (!player) {
    player = { id: uid(), name: cleaned, joinedAt: now }
    t.players.push(player)
  }

  const prev = t.scores
    .filter((s) => s.playerId === player!.id && s.game === game)
    .reduce((max, s) => Math.max(max, s.score), 0)

  const improved = score > prev
  if (improved) {
    // Keep a single best row per player/game
    t.scores = t.scores.filter((s) => !(s.playerId === player!.id && s.game === game))
    t.scores.push({
      playerId: player.id,
      game,
      score,
      at: now,
    })
    writeStore(store)
  }

  return {
    tournament: getTournamentDetail(id, now)!,
    accepted: true,
    best: Math.max(prev, score),
    improved,
  }
}

export function activeTournamentsForGame(game: GameSlug, now = Date.now()) {
  return ensureStore()
    .tournaments.filter(
      (t) => tournamentStatus(t, now) === 'active' && t.games.includes(game),
    )
    .map((t) => publicTournament(t, now))
}

function cleanName(name: string) {
  return name.trim().slice(0, 12).toUpperCase() || 'PLAYER'
}

type TournamentRecord = Tournament

/** Merge `source` into `target` (best scores win), then drop `source`. */
function mergeTournamentPlayers(
  t: TournamentRecord,
  source: TournamentPlayer,
  target: TournamentPlayer,
) {
  if (source.id === target.id) return
  for (const game of t.games) {
    const sourceBest = t.scores
      .filter((s) => s.playerId === source.id && s.game === game)
      .reduce((max, s) => Math.max(max, s.score), 0)
    if (sourceBest <= 0) continue

    const targetBest = t.scores
      .filter((s) => s.playerId === target.id && s.game === game)
      .reduce((max, s) => Math.max(max, s.score), 0)

    if (sourceBest > targetBest) {
      t.scores = t.scores.filter((s) => !(s.playerId === target.id && s.game === game))
      const latest = t.scores
        .filter((s) => s.playerId === source.id && s.game === game)
        .sort((a, b) => b.at - a.at)[0]
      t.scores.push({
        playerId: target.id,
        game,
        score: sourceBest,
        at: latest?.at ?? Date.now(),
      })
    }
  }

  t.scores = t.scores.filter((s) => s.playerId !== source.id)
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

