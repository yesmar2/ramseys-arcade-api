import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedGame, type GameSlug } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'tournaments.json')

export type TournamentStatus = 'upcoming' | 'active' | 'ended'

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

function dayMs(n: number) {
  return n * 24 * 60 * 60 * 1000
}

function seedWeekendTriple(now = Date.now()): Tournament {
  // Active window: now − 1h through now + 7 days (easy to join & play in dev)
  return {
    id: 'weekend-triple-1',
    title: 'Weekend Triple',
    blurb:
      'Play Stacker, Patriot, and Snake. Places earn points — highest total wins.',
    games: ['stacker', 'patriot', 'snake'],
    startsAt: now - 60 * 60 * 1000,
    endsAt: now + dayMs(7),
    official: true,
    players: [],
    scores: [],
  }
}

function emptyStore(now = Date.now()): Store {
  return { tournaments: [seedWeekendTriple(now)] }
}

function ensureStore(): Store {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!fs.existsSync(STORE_PATH)) {
    const empty = emptyStore()
    fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2))
    return empty
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Store
    if (!Array.isArray(parsed.tournaments) || parsed.tournaments.length === 0) {
      const seeded = emptyStore()
      writeStore(seeded)
      return seeded
    }
    return { tournaments: parsed.tournaments }
  } catch {
    return emptyStore()
  }
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
    status: tournamentStatus(t, now),
    playerCount: t.players.length,
  }
}

export function listTournaments(now = Date.now()) {
  const store = ensureStore()
  return store.tournaments
    .map((t) => publicTournament(t, now))
    .sort((a, b) => {
      const order = { active: 0, upcoming: 1, ended: 2 } as const
      return order[a.status] - order[b.status] || a.startsAt - b.startsAt
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
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        b.gamesPlayed - a.gamesPlayed ||
        a.name.localeCompare(b.name),
    )
}

export function getTournamentDetail(id: string, now = Date.now()) {
  const t = getTournament(id)
  if (!t) return null
  return {
    ...publicTournament(t, now),
    players: t.players.map((p) => ({ id: p.id, name: p.name, joinedAt: p.joinedAt })),
    standings: computeStandings(t),
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

