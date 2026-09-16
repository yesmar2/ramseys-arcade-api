/*
 * Seed a believable arcade: ~150 players with accounts and tags, months of
 * scores shaped by skill and habit, record-book entries, weekly and monthly
 * trophies computed from those scores, events with real standings and
 * finished brackets, friends, requests, and groups.
 *
 *   npm run seed:world            add it all (idempotent: clears its own rows first)
 *   npm run seed:world -- --clear remove everything this script added
 *
 * Everything it writes is marked: ids start with `seed-`, accounts use the
 * `@seed.skermix.dev` domain, and trophies belong to seeded tags or seeded
 * events. Real players' rows are never touched, except that the signed-in
 * player named in --you (default DAD) is placed into events and friendships
 * so the app has something to show from their point of view.
 */

import { eq, inArray, like, or, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bracketHasChampion,
  findOpenMatch,
  lockBracket,
  resolveReadyMatches,
} from './bracket.js'
import { closeDb, db } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import {
  accounts,
  directedInvites,
  friendRequests,
  friendships,
  groupMembers,
  groups,
  leaderboardScores,
  nameClaims,
  recordScores,
  tournaments as tournamentsTable,
  trophyAwards,
  trophyCursor,
} from './db/schema.js'
import { randomAvatarId } from './avatars.js'
import { getClaim } from './names.js'
import {
  ASTEROIDS_WAVE_MAX,
  CROSSWALK_ROW_MILESTONE_MAX,
  CROSSWALK_ROW_MILESTONE_MIN,
  CROSSWALK_ROW_MILESTONE_STEP,
  listRecordDefs,
  PLAY_DAYS_STREAK_ID,
  SNAKE_LENGTH_MILESTONE_MAX,
  SNAKE_LENGTH_MILESTONE_MIN,
  SNAKE_LENGTH_MILESTONE_STEP,
  THRESHOLD_STREAK_ID,
} from './records.js'
import {
  ALLOWED_GAMES,
  globalRanksForClosedPeriod,
  monthKey,
  weekStartKey,
  type DeviceType,
  type GameSlug,
} from './store.js'
import {
  computeStandings,
  tournamentWinner,
  type Tournament,
  type TournamentPlayer,
  type TournamentScore,
} from './tournaments.js'
import { awardEventWin, ensurePeriodTrophies } from './trophies.js'
import { assertNotProduction } from './env.js'

/* ---------- env ---------- */

function loadDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'),
  ]
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (process.env[key] == null || process.env[key] === '') process.env[key] = value
      }
      return
    } catch {
      /* try next */
    }
  }
}

/* ---------- randomness ---------- */

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20260915)
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
const chance = (p: number) => rand() < p
function shuffle<T>(list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

let idCounter = 0
const sid = (kind: string) => `seed-${kind}-${(++idCounter).toString(36).padStart(4, '0')}`

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.now()

/* ---------- who ---------- */

/**
 * Tags people actually pick: first names, nicknames, a few with numbers,
 * a few in-joke handles. All ≤ 12 characters, uppercase.
 */
const TAGS = [
  'MAYA', 'LIAM', 'SOFIA', 'NOAH', 'ZOE', 'MILO', 'ELLIE', 'RAFA', 'PRIYA', 'OWEN',
  'NELL', 'HUGO', 'IVY', 'CASS', 'DREW', 'JUNE', 'THEO', 'RUBY', 'FINN', 'LEO',
  'EMMY', 'GUS', 'NORA', 'AXEL', 'BEA', 'COLE', 'DEX', 'ETTA', 'FRAN', 'GIL',
  'HANK', 'ISLA', 'JAX', 'KIRA', 'LUKE', 'MAE', 'NICO', 'OLLIE', 'QUINN', 'SASHA',
  'TESS', 'UMA', 'VIC', 'WES', 'XAVI', 'YARA', 'ZANE', 'ARLO', 'BRYN', 'CLEO',
  'DANI', 'EZRA', 'FAYE', 'GRETA', 'HOLT', 'INES', 'JONAH', 'KIT', 'LENA', 'MARCO',
  'NADIA', 'OTIS', 'PAZ', 'REESE', 'SAUL', 'TOVA', 'ULLA', 'VERA', 'WADE', 'YUKI',
  'PIXELPAT', 'SNAKEKING', 'STACKR', 'GHOSTRUN', 'NOSCOPE', 'LAGSPIKE', 'COMBOKID',
  'BOSSMOM', 'GRANDPAJ', 'COACHK', 'MRSB', 'DADJOKES', 'NIGHTOWL', 'EARLYBIRD',
  'LEFTY', 'SOUTHPAW', 'ROOKIE', 'VETERAN', 'GLITCH', 'TURBO', 'MOSS', 'BRICK',
  'PEPPER', 'BISCUIT', 'WAFFLES', 'NUGGET', 'PICKLE', 'TATER', 'MOCHA', 'LATTE',
  'COCOA', 'TAYLOR7', 'JORDAN23', 'KAI_M', 'SAM2', 'ALEX99', 'BEN_R', 'CJ', 'TJ',
  'AJ', 'MJ', 'KBEAR', 'LILBIT', 'BIGRED', 'SPUD', 'TINY', 'MOOSE', 'BEAR', 'HAWK',
  'FALCON', 'OTTER', 'FOX', 'LYNX', 'PANDA', 'KOALA', 'MANTIS', 'HORNET', 'WASP',
  'DRONE', 'PILOT', 'CAPTAIN', 'CHIEF', 'SARGE', 'DOC', 'NURSE', 'TEACH', 'PROF',
  'UNCLE_T', 'AUNTIE', 'NANA', 'POPS', 'CUZ', 'NEPHEW', 'SIS', 'BRO', 'THETWINS',
  'ROOMIE', 'NEIGHBOR', 'MAILMAN', 'BARISTA', 'CHEF', 'DJ_MOE', 'LOOPER', 'REWIND',
] as const

const DEVICES: DeviceType[] = ['phone', 'phone', 'phone', 'tablet', 'desktop', 'desktop']

type Player = {
  tag: string
  accountId: string
  email: string
  avatarId: string
  /** 0 casual … 1 elite. */
  skill: number
  /** 0 rare … 1 daily. */
  activity: number
  device: DeviceType
  favorites: GameSlug[]
  joinedAt: number
}

/** Real score bands per game, casual → elite. Same shape the games produce. */
const BANDS: Record<GameSlug, { min: number; max: number; step?: number }> = {
  stacker: { min: 6, max: 118 },
  patriot: { min: 480, max: 28_600, step: 5 },
  snake: { min: 30, max: 1180, step: 10 },
  pop: { min: 70, max: 920, step: 5 },
  centroid: { min: 420, max: 7420, step: 10 },
  asteroids: { min: 280, max: 14_200, step: 10 },
  simon: { min: 2, max: 26 },
  crosswalk: { min: 12, max: 420 },
  spotter: { min: 940_000, max: 999_500, step: 1000 },
  pellets: { min: 120, max: 18_600, step: 10 },
  findbug: { min: 850_000, max: 975_000, step: 500 },
  crumbtrail: { min: 150, max: 21_400, step: 10 },
  bop: { min: 3, max: 74 },
  putt: { min: 300, max: 3200, step: 100 },
}

function roundTo(value: number, step = 1) {
  return Math.max(0, Math.round(value / step) * step)
}

/** A run's score for a player: skill sets the band, the day sets the mood. */
function runScore(game: GameSlug, skill: number, form: number) {
  const band = BANDS[game]
  const shaped = Math.min(1, Math.pow(skill, 1.3) * (0.7 + form * 0.5))
  const raw = band.min + (band.max - band.min) * shaped
  return roundTo(raw * (0.92 + rand() * 0.16), band.step ?? 1)
}

function makePlayers(existing: Set<string>): Player[] {
  const tags = TAGS.filter((t) => !existing.has(t))
  return tags.map((tag, i) => {
    // Skill: most people are middling, a handful are very good.
    const u = rand()
    const skill = Math.min(1, Math.max(0.05, Math.pow(u, 1.6) * 0.9 + rand() * 0.15))
    const activity = Math.min(1, Math.max(0.08, Math.pow(rand(), 1.2)))
    const favCount = 2 + Math.floor(rand() * 5)
    const favorites = shuffle([...ALLOWED_GAMES]).slice(0, favCount)
    const joinedAt = NOW - Math.floor(between(7, 95)) * DAY
    return {
      tag,
      accountId: `seed-acct-${(i + 1).toString().padStart(3, '0')}`,
      email: `${tag.toLowerCase()}@seed.skermix.dev`,
      avatarId: randomAvatarId(rand),
      skill,
      activity,
      device: pick(DEVICES),
      favorites,
      joinedAt,
    }
  })
}

/* ---------- clear ---------- */

async function clearSeed() {
  const d = db()
  const seedTags = [...TAGS]
  await d.delete(leaderboardScores).where(like(leaderboardScores.id, 'seed-%'))
  await d.delete(recordScores).where(like(recordScores.id, 'seed-%'))
  await d.delete(tournamentsTable).where(like(tournamentsTable.id, 'seed-%'))
  await d
    .delete(trophyAwards)
    .where(or(inArray(trophyAwards.name, seedTags), like(trophyAwards.eventId, 'seed-%')))
  await d.delete(friendships).where(like(friendships.id, 'seed-%'))
  await d.delete(friendRequests).where(like(friendRequests.id, 'seed-%'))
  await d.delete(groupMembers).where(like(groupMembers.groupId, 'seed-%'))
  await d.delete(groups).where(like(groups.id, 'seed-%'))
  await d.delete(directedInvites).where(like(directedInvites.id, 'seed-%'))
  await d.delete(nameClaims).where(like(nameClaims.accountId, 'seed-acct-%'))
  await d.delete(accounts).where(like(accounts.email, '%@seed.skermix.dev'))
}

/* ---------- accounts + tags ---------- */

async function seedAccounts(players: Player[]) {
  const d = db()
  const chunk = 100
  for (let i = 0; i < players.length; i += chunk) {
    const slice = players.slice(i, i + chunk)
    await d.insert(accounts).values(
      slice.map((p) => ({
        id: p.accountId,
        email: p.email,
        createdAt: p.joinedAt,
        plan: 'free',
        googleSub: null,
      })),
    )
    await d.insert(nameClaims).values(
      slice.map((p) => ({
        name: p.tag,
        token: `seed-${p.tag.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedAt: p.joinedAt,
        accountId: p.accountId,
        avatarId: p.avatarId,
      })),
    )
  }
}

/* ---------- scores ---------- */

type ScoreRow = typeof leaderboardScores.$inferInsert

/** Timestamps a person's runs across their tenure, weighted toward lately. */
function sessionTimes(p: Player, count: number): number[] {
  const span = NOW - p.joinedAt
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    // Square the draw so more sessions land recently — people who are still
    // playing keep playing, and the weekly board needs to look alive.
    const back = Math.pow(rand(), 1.8) * span
    const at = NOW - back
    // Evenings mostly.
    const hour = chance(0.65) ? between(18, 23) : between(8, 18)
    const day = new Date(at)
    day.setHours(Math.floor(hour), Math.floor(rand() * 60), Math.floor(rand() * 60), 0)
    times.push(Math.min(NOW - 60_000, day.getTime()))
  }
  return times.sort((a, b) => a - b)
}

function seedScoresFor(players: Player[]): ScoreRow[] {
  const rows: ScoreRow[] = []
  for (const p of players) {
    for (const game of p.favorites) {
      const sessions = Math.max(1, Math.round(p.activity * 9 + rand() * 3))
      const times = sessionTimes(p, sessions)
      times.forEach((at, i) => {
        // Slight improvement over time, with off days.
        const progress = times.length > 1 ? i / (times.length - 1) : 1
        const form = 0.45 + progress * 0.35 + (rand() - 0.5) * 0.4
        rows.push({
          id: sid('lb'),
          game,
          name: p.tag,
          score: runScore(game, p.skill, Math.max(0.1, form)),
          at,
          device: chance(0.85) ? p.device : pick(DEVICES),
        })
      })
    }
    // Everyone has tried one game outside their favourites once.
    if (chance(0.6)) {
      const game = pick(ALLOWED_GAMES.filter((g) => !p.favorites.includes(g)))
      rows.push({
        id: sid('lb'),
        game,
        name: p.tag,
        score: runScore(game, p.skill * 0.6, 0.4),
        at: sessionTimes(p, 1)[0]!,
        device: p.device,
      })
    }
  }
  // History keeps the top 500 per game; stay under that so nothing seeded
  // is trimmed by the next real score.
  const byGame = new Map<string, ScoreRow[]>()
  for (const row of rows) byGame.set(row.game, [...(byGame.get(row.game) ?? []), row])
  const kept: ScoreRow[] = []
  for (const list of byGame.values()) {
    list.sort((a, b) => b.score - a.score || a.at - b.at)
    kept.push(...list.slice(0, 440))
  }
  return kept
}

async function insertRows<T extends object>(table: Parameters<ReturnType<typeof db>['insert']>[0], rows: T[]) {
  const chunk = 200
  for (let i = 0; i < rows.length; i += chunk) {
    await db().insert(table).values(rows.slice(i, i + chunk) as never)
  }
}

/* ---------- records ---------- */

type RecordRow = typeof recordScores.$inferInsert

function recordRow(game: GameSlug, recordId: string, p: Player, score: number, at: number): RecordRow {
  return { id: sid('rec'), game, recordId, name: p.tag, score, at, device: p.device }
}

function seedRecordsFor(players: Player[]): RecordRow[] {
  const rows: RecordRow[] = []
  const playersOf = (game: GameSlug) => players.filter((p) => p.favorites.includes(game))
  const daysAgo = (max: number) => NOW - Math.floor(rand() * max) * DAY - Math.floor(rand() * 12) * HOUR

  for (const game of ALLOWED_GAMES) {
    const pool = playersOf(game)
    for (const def of listRecordDefs(game)) {
      let entrants: Player[]
      let value: (p: Player) => number
      if (def.id === PLAY_DAYS_STREAK_ID) {
        entrants = pool.filter((p) => p.activity > 0.35)
        value = (p) => Math.max(2, Math.round(2 + p.activity * 14 + rand() * 4))
      } else if (def.id === THRESHOLD_STREAK_ID) {
        entrants = pool.filter((p) => p.skill > 0.35)
        value = (p) => Math.max(2, Math.round(1 + p.skill * 9 + rand() * 3))
      } else if (def.id.startsWith('wave-time-')) {
        const wave = Number(def.id.slice('wave-time-'.length))
        entrants = pool.filter((p) => p.skill >= (wave / ASTEROIDS_WAVE_MAX) * 0.7 - 0.1)
        value = (p) => {
          const baseSec = 28 + wave * 9 + wave * wave * 0.55
          return Math.round(baseSec * 1000 * (1.02 + (1 - p.skill) * 0.38 + rand() * 0.18))
        }
      } else if (def.id.startsWith('fastest-length-')) {
        const length = Number(def.id.slice('fastest-length-'.length))
        entrants = pool.filter((p) => p.skill >= (length / SNAKE_LENGTH_MILESTONE_MAX) * 0.7)
        value = (p) =>
          Math.max(6_500, Math.round(Math.max(1, length - 3) * (1.85 - p.skill * 0.65 + rand() * 0.45) * 1000))
      } else if (def.id.startsWith('fastest-row-')) {
        const rowsN = Number(def.id.slice('fastest-row-'.length))
        entrants = pool.filter((p) => p.skill >= (rowsN / CROSSWALK_ROW_MILESTONE_MAX) * 0.65)
        value = (p) => Math.max(8_000, Math.round(rowsN * (0.95 - p.skill * 0.35 + rand() * 0.28) * 1000))
      } else if (def.id === 'highest-combo' || def.id === 'direct-streak' || def.id === 'perfect-streak') {
        entrants = pool.filter((p) => p.skill > 0.2)
        value = (p) => Math.max(2, Math.min(18, Math.round(2 + p.skill * 9 + rand() * 4)))
      } else if (def.id === 'center-streak' || def.id === 'crumb-streak') {
        entrants = pool.filter((p) => p.skill > 0.2)
        value = (p) => Math.max(2, Math.min(24, Math.round(2 + p.skill * 12 + rand() * 5)))
      } else if (def.id === 'most-coins') {
        entrants = pool.filter((p) => p.skill > 0.15)
        value = (p) => Math.max(2, Math.min(48, Math.round(3 + p.skill * 30 + rand() * 10)))
      } else if (def.id === 'most-rows') {
        entrants = pool.filter((p) => p.skill > 0.15)
        value = (p) => Math.max(10, Math.round(10 + p.skill * 160 + rand() * 30))
      } else {
        continue
      }
      for (const p of shuffle(entrants).slice(0, 6 + Math.floor(rand() * 16))) {
        rows.push(recordRow(game, def.id, p, value(p), daysAgo(45)))
      }
    }
  }
  return rows
}

/* ---------- events ---------- */

const EVENT_GAMES = ALLOWED_GAMES.filter((g) => g !== 'crosswalk' && g !== 'spotter')

function playerSeat(p: Player, joinedAt: number): TournamentPlayer {
  return { id: sid('seat'), name: p.tag, joinedAt, accountId: p.accountId }
}

function youSeat(you: { tag: string; accountId: string | null }, joinedAt: number): TournamentPlayer {
  return { id: sid('seat'), name: you.tag, joinedAt, ...(you.accountId ? { accountId: you.accountId } : {}) }
}

/** Score a scores-event roster: each player plays some of the games, some attempts each. */
function playScoresEvent(
  t: Tournament,
  skillOf: (name: string) => number,
  startedAt: number,
  endedAt: number,
  maxAttempts: number,
) {
  for (const seat of t.players) {
    const skill = skillOf(seat.name)
    for (const game of t.games) {
      if (chance(0.22)) continue // skipped this one
      const tries = Math.max(1, Math.min(maxAttempts || 3, 1 + Math.floor(rand() * 3)))
      for (let a = 1; a <= tries; a++) {
        const score: TournamentScore = {
          playerId: seat.id,
          game,
          score: runScore(game, skill, 0.5 + rand() * 0.4),
          at: Math.floor(between(startedAt, endedAt)),
          attempt: a,
        }
        t.scores.push(score)
      }
    }
  }
}

/** Play a locked bracket forward, one round of matches at a time. */
function playBracket(
  t: Tournament,
  skillOf: (name: string) => number,
  from: number,
  opts: { stopBeforeChampion?: boolean; leaveOpenFor?: string | null } = {},
) {
  let clock = from
  for (let guard = 0; guard < 12 && !bracketHasChampion(t); guard++) {
    const open = (t.bracket?.matches ?? []).filter(
      (m) => !m.winnerId && m.playerIds[0] && m.playerIds[1],
    )
    if (!open.length) break
    // Leave the named player's match open, and stop short of the crown if asked.
    const leaveId = opts.leaveOpenFor
      ? findOpenMatch(t, t.players.find((p) => p.name === opts.leaveOpenFor)?.id ?? '')?.id
      : null
    const playable = open.filter((m) => m.id !== leaveId)
    if (!playable.length) break
    if (opts.stopBeforeChampion && open.length === 1 && !leaveId) break
    clock += HOUR * between(2, 9)
    for (const m of playable) {
      for (const pid of m.playerIds) {
        if (!pid) continue
        const name = t.players.find((p) => p.id === pid)?.name ?? ''
        t.scores.push({
          playerId: pid,
          game: t.games[0]!,
          score: runScore(t.games[0]!, skillOf(name), 0.4 + rand() * 0.5),
          at: clock + Math.floor(rand() * HOUR),
          attempt: 1,
          matchId: m.id,
        })
      }
    }
    resolveReadyMatches(t, 1)
    if (leaveId) {
      // Give the opponent their run so the open match has something to beat.
      const m = t.bracket!.matches.find((x) => x.id === leaveId)!
      const you = t.players.find((p) => p.name === opts.leaveOpenFor)?.id
      const opp = m.playerIds.find((id) => id && id !== you)
      if (opp && !t.scores.some((s) => s.matchId === m.id && s.playerId === opp)) {
        const name = t.players.find((p) => p.name === opp)?.name ?? ''
        t.scores.push({
          playerId: opp,
          game: t.games[0]!,
          score: runScore(t.games[0]!, skillOf(name), 0.6),
          at: clock,
          attempt: 1,
          matchId: m.id,
        })
      }
      // Only ever play up to the round that holds their match.
      if (!m.winnerId) break
    }
  }
  return clock
}

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(rand() * chars.length)]
  return code
}

type You = { tag: string; accountId: string | null }

function buildEvents(players: Player[], you: You): Tournament[] {
  const skillOf = (name: string) => players.find((p) => p.tag === name)?.skill ?? 0.55
  const host = (p: Player) => ({ accountId: p.accountId, email: p.email })
  const regulars = shuffle(players.filter((p) => p.activity > 0.3))
  const events: Tournament[] = []

  const roster = (n: number, startedAt: number, includeYou: boolean) => {
    const seats = regulars.slice(0, n - (includeYou ? 1 : 0)).map((p) =>
      playerSeat(p, startedAt + Math.floor(rand() * 6 * HOUR)),
    )
    if (includeYou) seats.push(youSeat(you, startedAt + Math.floor(rand() * 4 * HOUR)))
    regulars.push(...regulars.splice(0, n))
    return shuffle(seats)
  }

  // Three finished score events over the last month.
  const finished: { title: string; games: GameSlug[]; daysAgo: number; hours: number; n: number; tries: number }[] = [
    { title: 'Friday Night Triple', games: ['stacker', 'pop', 'simon'], daysAgo: 24, hours: 48, n: 14, tries: 3 },
    { title: 'Office League · Week 2', games: ['asteroids', 'pellets'], daysAgo: 12, hours: 96, n: 11, tries: 2 },
    { title: 'Snake Sunday', games: ['snake'], daysAgo: 5, hours: 24, n: 9, tries: 5 },
  ]
  for (const f of finished) {
    const startsAt = NOW - f.daysAgo * DAY
    const endsAt = startsAt + f.hours * HOUR
    const t: Tournament = {
      id: sid('ev'),
      title: f.title,
      blurb:
        f.games.length > 1
          ? 'Place points across games — highest total wins.'
          : `${f.tries} tries. Best score wins.`,
      games: f.games,
      startsAt,
      endsAt,
      official: false,
      cadence: null,
      format: f.games.length > 1 ? 'place-points' : 'attempt-limited',
      kind: 'scores',
      rules: { maxAttempts: f.tries, maxPlayers: 0, scoring: 'best' },
      createdBy: host(regulars[0]!),
      visibility: 'private',
      inviteCode: inviteCode(),
      players: roster(f.n, startsAt, true),
      scores: [],
    }
    playScoresEvent(t, skillOf, startsAt, endsAt, f.tries)
    events.push(t)
  }

  // Two running score events you are in, one ending soon and one long.
  const running: { title: string; games: GameSlug[]; hoursAgo: number; hours: number; n: number; tries: number }[] = [
    { title: 'Lunch Break Ladder', games: ['pop', 'centroid', 'simon'], hoursAgo: 30, hours: 72, n: 12, tries: 0 },
    { title: 'Patriot Standoff', games: ['patriot'], hoursAgo: 5, hours: 24, n: 7, tries: 3 },
  ]
  for (const r of running) {
    const startsAt = NOW - r.hoursAgo * HOUR
    const endsAt = startsAt + r.hours * HOUR
    const t: Tournament = {
      id: sid('ev'),
      title: r.title,
      blurb: r.games.length > 1 ? 'Place points across games — highest total wins.' : 'Best score wins.',
      games: r.games,
      startsAt,
      endsAt,
      official: false,
      cadence: null,
      format: r.games.length > 1 ? 'place-points' : r.tries ? 'attempt-limited' : 'open',
      kind: 'scores',
      rules: { maxAttempts: r.tries, maxPlayers: 0, scoring: 'best' },
      createdBy: host(regulars[1]!),
      visibility: 'private',
      inviteCode: inviteCode(),
      players: roster(r.n, startsAt, true),
      scores: [],
    }
    playScoresEvent(t, skillOf, startsAt, NOW - 10 * 60_000, r.tries || 3)
    // Not everyone has played every game yet in a running event.
    t.scores = t.scores.filter(() => chance(0.7))
    events.push(t)
  }

  // A finished 16-player double-elim you were in, won by a strong player.
  {
    const startsAt = NOW - 9 * DAY
    const t: Tournament = {
      id: sid('ev'),
      title: 'Stacker Sixteen',
      blurb: 'Double-elim bracket — higher score wins each match. Stacker.',
      games: ['stacker'],
      startsAt,
      endsAt: startsAt,
      official: false,
      cadence: null,
      format: 'single-run',
      kind: 'bracket',
      rules: { maxAttempts: 1, maxPlayers: 16, scoring: 'best', unlimitedDuration: true, roundPlayHours: 12, elimination: 'double' },
      createdBy: host(regulars[2]!),
      visibility: 'private',
      inviteCode: inviteCode(),
      players: roster(16, startsAt, true),
      scores: [],
    }
    lockBracket(t, startsAt + 6 * HOUR)
    playBracket(t, skillOf, startsAt + 6 * HOUR)
    events.push(t)
  }

  // A live 8-player single-elim with your match open right now.
  {
    const startsAt = NOW - 26 * HOUR
    const t: Tournament = {
      id: sid('ev'),
      title: 'Asteroids Cup',
      blurb: 'Single-elim bracket — higher score wins each match. Asteroids.',
      games: ['asteroids'],
      startsAt,
      endsAt: startsAt,
      official: false,
      cadence: null,
      format: 'single-run',
      kind: 'bracket',
      rules: { maxAttempts: 2, maxPlayers: 8, scoring: 'best', unlimitedDuration: true, roundPlayHours: 24, elimination: 'single' },
      createdBy: host(regulars[3]!),
      visibility: 'private',
      inviteCode: inviteCode(),
      players: roster(8, startsAt, true),
      scores: [],
    }
    lockBracket(t, startsAt + 3 * HOUR)
    playBracket(t, skillOf, startsAt + 3 * HOUR, { leaveOpenFor: you.tag, stopBeforeChampion: true })
    // Re-arm the open match clock so it ends in the future.
    for (const m of t.bracket?.matches ?? []) {
      if (!m.winnerId && m.playerIds[0] && m.playerIds[1]) m.playEndsAt = NOW + between(6, 20) * HOUR
    }
    events.push(t)
  }

  // A bracket still filling: 6 of 8 seats, you in it.
  {
    const startsAt = NOW - 2 * DAY
    const t: Tournament = {
      id: sid('ev'),
      title: 'Pellets Eight',
      blurb: 'Single-elim bracket — higher score wins each match. Pellets.',
      games: ['pellets'],
      startsAt,
      endsAt: startsAt,
      official: false,
      cadence: null,
      format: 'single-run',
      kind: 'bracket',
      rules: { maxAttempts: 1, maxPlayers: 8, scoring: 'best', unlimitedDuration: true, roundPlayHours: 24, elimination: 'single' },
      createdBy: host(regulars[4]!),
      visibility: 'private',
      inviteCode: inviteCode(),
      players: roster(6, startsAt, true),
      scores: [],
    }
    events.push(t)
  }

  return events
}

/** Fill the current daily and weekly, and the last few, with seeded players. */
async function joinOfficialEvents(players: Player[]) {
  const d = db()
  const rows = await d.select().from(tournamentsTable)
  const skillOf = (name: string) => players.find((p) => p.tag === name)?.skill ?? 0.55
  const regulars = shuffle(players.filter((p) => p.activity > 0.25))
  let cursor = 0
  for (const row of rows) {
    const t = row.data as Tournament
    if (!t.official || !t.cadence) continue
    if (!t.games.every((g) => (EVENT_GAMES as readonly string[]).includes(g))) continue
    const ended = t.endsAt <= NOW
    const already = new Set(t.players.map((p) => p.name))
    const n = t.cadence === 'weekly' ? 28 + Math.floor(rand() * 18) : 14 + Math.floor(rand() * 16)
    const joiners = regulars.slice(cursor, cursor + n).filter((p) => !already.has(p.tag))
    cursor = (cursor + n) % Math.max(1, regulars.length - n)
    const untilAt = ended ? t.endsAt : NOW - 5 * 60_000
    const seats = joiners.map((p) =>
      playerSeat(p, Math.floor(between(t.startsAt, Math.min(untilAt, t.startsAt + 20 * HOUR)))),
    )
    // Score only the seeded seats; real players' entries are carried as-is.
    const seededOnly: Tournament = { ...t, players: seats, scores: [] }
    playScoresEvent(seededOnly, skillOf, t.startsAt, untilAt, 3)
    const fresh: Tournament = {
      ...t,
      players: [...t.players, ...seats],
      scores: [...t.scores, ...seededOnly.scores],
    }
    await d
      .update(tournamentsTable)
      .set({ data: fresh as unknown as Record<string, unknown> })
      .where(eq(tournamentsTable.id, t.id))
  }
}

/* ---------- social ---------- */

async function seedSocial(players: Player[], you: You) {
  const d = db()
  const now = NOW
  const friendshipRows: (typeof friendships.$inferInsert)[] = []
  const pairs = new Set<string>()
  const link = (a: string, b: string, at: number) => {
    const [x, y] = a < b ? [a, b] : [b, a]
    const key = `${x}|${y}`
    if (pairs.has(key)) return
    pairs.add(key)
    friendshipRows.push({ id: sid('fr'), accountIdA: x, accountIdB: y, createdAt: at })
  }
  // Everyone has a few friends; the active have more.
  for (const p of players) {
    const n = Math.round(1 + p.activity * 7)
    for (const q of shuffle(players).slice(0, n)) {
      if (q.accountId !== p.accountId) link(p.accountId, q.accountId, now - Math.floor(rand() * 60) * DAY)
    }
  }
  const requests: (typeof friendRequests.$inferInsert)[] = []
  if (you.accountId) {
    const circle = shuffle(players.filter((p) => p.activity > 0.4))
    for (const p of circle.slice(0, 9)) link(you.accountId, p.accountId, now - Math.floor(rand() * 40) * DAY)
    for (const p of circle.slice(9, 11)) {
      requests.push({
        id: sid('frq'),
        fromAccountId: p.accountId,
        fromName: p.tag,
        toAccountId: you.accountId,
        toName: you.tag,
        status: 'pending',
        createdAt: now - Math.floor(rand() * 3) * DAY,
        expiresAt: now + 27 * DAY,
      })
    }
    requests.push({
      id: sid('frq'),
      fromAccountId: you.accountId,
      fromName: you.tag,
      toAccountId: circle[11]!.accountId,
      toName: circle[11]!.tag,
      status: 'pending',
      createdAt: now - DAY,
      expiresAt: now + 29 * DAY,
    })
  }
  await insertRows(friendships, friendshipRows)
  if (requests.length) await insertRows(friendRequests, requests)

  // Groups: two circles of players, you in one of them.
  const groupDefs = [
    { name: 'Thursday Crew', size: 12, withYou: true },
    { name: 'Office League', size: 18, withYou: false },
    { name: 'Cousins', size: 7, withYou: true },
  ]
  for (const g of groupDefs) {
    const members = shuffle(players).slice(0, g.size)
    const owner = members[0]!
    const id = sid('group')
    await d.insert(groups).values({ id, name: g.name, inviteCode: inviteCode(), createdByAccountId: owner.accountId })
    const memberRows = members.map((m) => ({ groupId: id, name: m.tag, joinedAt: now - Math.floor(rand() * 50) * DAY }))
    if (g.withYou) memberRows.push({ groupId: id, name: you.tag, joinedAt: now - 20 * DAY })
    await insertRows(groupMembers, memberRows)
  }
}

async function seedInvite(events: Tournament[], players: Player[], you: You) {
  // One pending event invite for you, so the header badge has something to count.
  const target = events.find((t) => t.kind !== 'bracket' && t.endsAt > NOW && !t.players.some((p) => p.name === you.tag))
  const from = players.find((p) => p.accountId === target?.createdBy?.accountId)
  if (!target || !from || !target.inviteCode) return
  await db().insert(directedInvites).values({
    id: sid('inv'),
    kind: 'tournament',
    targetId: target.id,
    targetName: target.title,
    fromAccountId: from.accountId,
    fromName: from.tag,
    toName: you.tag,
    inviteCode: target.inviteCode,
    status: 'pending',
    createdAt: NOW - 3 * HOUR,
    expiresAt: NOW + 13 * DAY,
  })
}

/* ---------- trophies ---------- */

async function seedTrophies(events: Tournament[]) {
  // Board trophies: recompute the last 8 weeks / 6 months from the boards as
  // they now stand. Awards that already exist are left alone.
  await db()
    .insert(trophyCursor)
    .values({ id: 'default', weeklyInitialized: false, monthlyInitialized: false })
    .onConflictDoUpdate({
      target: trophyCursor.id,
      set: { weeklyInitialized: false, monthlyInitialized: false },
    })
  await ensurePeriodTrophies(NOW)

  // Event wins for the finished seeded events.
  for (const t of events) {
    const winner = tournamentWinner(t, NOW)
    if (!winner) continue
    const key = Number(new Date(t.startsAt).toISOString().slice(0, 10).replace(/-/g, ''))
    const top = computeStandings(t).find((row) => row.name === winner)
    await awardEventWin({
      eventId: t.id,
      eventTitle: t.title,
      periodKey: key,
      name: winner,
      score: top?.totalPoints ?? 0,
      games: t.games.length,
      awardedAt: Math.min(NOW, t.endsAt + HOUR),
    })
  }
}

/* ---------- main ---------- */

async function main() {
  loadDotEnv()
  // After the .env is read, so the branch it names is the one we check.
  assertNotProduction('rebuild the world')
  await runMigrations()
  const clearOnly = process.argv.includes('--clear')
  const youArg = process.argv.find((a) => a.startsWith('--you='))
  const youTag = (youArg ? youArg.slice(6) : 'DAD').trim().toUpperCase().slice(0, 12)

  console.log('Clearing previous seed…')
  await clearSeed()
  if (clearOnly) {
    console.log('Seed data removed.')
    return
  }

  const existing = new Set(
    (await db().select({ name: nameClaims.name }).from(nameClaims)).map((r) => r.name),
  )
  const players = makePlayers(existing)
  const youClaim = await getClaim(youTag)
  const you: You = { tag: youTag, accountId: youClaim?.accountId ?? null }
  if (!you.accountId) {
    console.log(`No account owns ${youTag}; friends and requests for them will be skipped.`)
  }

  console.log(`Creating ${players.length} players…`)
  await seedAccounts(players)

  console.log('Posting scores…')
  const scores = seedScoresFor(players)
  await insertRows(leaderboardScores, scores)
  console.log(`  ${scores.length} runs across ${ALLOWED_GAMES.length} games`)

  console.log('Filling record books…')
  const records = seedRecordsFor(players)
  await insertRows(recordScores, records)
  console.log(`  ${records.length} record entries`)

  console.log('Running events…')
  const events = buildEvents(players, you)
  for (const t of events) {
    await db()
      .insert(tournamentsTable)
      .values({
        id: t.id,
        data: t as unknown as Record<string, unknown>,
        official: false,
        cadence: null,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        visibility: 'private',
        inviteCode: t.inviteCode ?? null,
      })
  }
  await joinOfficialEvents(players)
  console.log(`  ${events.length} hosted events, plus the official daily and weekly`)

  console.log('Handing out trophies…')
  await seedTrophies(events)

  console.log('Making friends…')
  await seedSocial(players, you)
  await seedInvite(events, players, you)

  const wk = weekStartKey(NOW)
  const mk = monthKey(NOW)
  const top = (await globalRanksForClosedPeriod('weekly', wk)).slice(0, 3)
  console.log(`This week so far (${wk}, month ${mk}): ${top.map((r) => `${r.name} ${r.score}`).join(', ') || 'no scores'}`)
  console.log('Done.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
