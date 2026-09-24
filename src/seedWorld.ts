/*
 * Seed a believable arcade.
 *
 * About 150 players, each with a skill, favourite games, a time of day they
 * tend to play and a habit of coming back, play the site day by day from the
 * day they joined. Every run is one of the game's own shapes (seedGames.ts),
 * and everything else is only what those runs would have made:
 *
 *   - the boards are the runs;
 *   - the record books are what each run posted, kept the way the API keeps
 *     them (only a value that beat the player's own best for the day, the
 *     week, the month or all time), and the streak books are counted from
 *     the runs themselves;
 *   - the daily and weekly events hold the runs of the players who joined
 *     them, and the hosted events and brackets were played by their rosters;
 *   - weekly and monthly trophies are ranked from the boards, and event wins
 *     from the events.
 *
 * Nobody real is touched. Every player is seeded, and no real tag is put in an
 * event, a group or a friendship.
 *
 *   npm run seed:world                  replace the seeded world
 *   npm run seed:world -- --backup      the same, backing up every table first
 *   npm run seed:world -- --clear       remove everything this script added
 *   npm run seed:world -- --fresh       back up every table to backups/, wipe
 *                                       all game data, real players' too, and
 *                                       seed
 *
 * --fresh keeps accounts, sign-ins, tags, bans and push subscriptions, and
 * empties the boards, record books, events, challenges, trophies, groups,
 * friends and notifications for everyone.
 *
 * Everything it writes is marked: ids start with `seed-`, accounts use the
 * `@seed.skermix.dev` domain, and trophies belong to seeded tags. The daily and
 * weekly events are the arcade's own, so their seeded seats carry `seed-` ids.
 */

import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomAvatarId } from './avatars.js'
import {
  armMatchClocks,
  bracketGamesForRound,
  bracketHasChampion,
  lockBracket,
  maybeEndWhenBracketFinished,
  resolveReadyMatches,
} from './bracket.js'
import { closeDb, db } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import {
  accounts,
  appMeta,
  challengeResults,
  challenges,
  directedInvites,
  friendRequests,
  friendships,
  gameRuns,
  groupMembers,
  groups,
  leaderboardScores,
  magicLinks,
  nameBans,
  nameClaims,
  notifications,
  pushLedger,
  pushSubscriptions,
  recordScores,
  runClaims,
  scoreFlags,
  sessions,
  tournamentPlayers,
  tournamentScores,
  tournaments as tournamentsTable,
  trophyAwards,
  trophyCursor,
} from './db/schema.js'
import { assertNotProduction, dbTarget } from './env.js'
import {
  computePlayDaysStreak,
  getRecordDef,
  PLAY_DAYS_STREAK_ID,
  SCORE_STREAK_THRESHOLDS,
  THRESHOLD_STREAK_ID,
} from './records.js'
import { playRun, SEEDED_GAMES, type RunRecord } from './seedGames.js'
import {
  BOARD_TZ,
  boardDateKey,
  filterByPeriod,
  globalRanksForClosedPeriod,
  monthKey,
  weekStartKey,
  type DeviceType,
  type GameSlug,
  type LeaderboardEntry,
  type Period,
} from './store.js'
import {
  buildDailyEvent,
  buildWeeklyEvent,
  computeStandings,
  tournamentWinner,
  type Tournament,
  type TournamentPlayer,
} from './tournaments.js'
import { awardEventWin, ensurePeriodTrophies } from './trophies.js'

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

const rand = mulberry32(20260923)
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
const chance = (p: number) => rand() < p
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
function gauss() {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}
function shuffle<T>(list: readonly T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

let idCounter = 0
const sid = (kind: string) => `seed-${kind}-${(++idCounter).toString(36).padStart(5, '0')}`

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.now()

/* ---------- the board's calendar ---------- */

const ZONE_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: BOARD_TZ, hour: 'numeric', hourCycle: 'h23' })

/** Midnight in the board's zone on board day `key` (YYYYMMDD). */
function dayStart(key: number): number {
  const y = Math.floor(key / 10_000)
  const m = Math.floor((key % 10_000) / 100)
  const d = key % 100
  for (const offset of [4, 5]) {
    const at = Date.UTC(y, m - 1, d, offset)
    if (boardDateKey(at) === key && Number(ZONE_HOUR.format(at)) === 0) return at
  }
  return Date.UTC(y, m - 1, d, 5)
}

const nextDay = (key: number) => boardDateKey(dayStart(key) + 30 * HOUR)
const addDays = (key: number, days: number) => boardDateKey(dayStart(key) + days * DAY + 12 * HOUR)
/** 0 Sunday … 6 Saturday. */
function weekday(key: number) {
  return new Date(Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100)).getUTCDay()
}
/** Hours since midnight in the board's zone. */
const hourOf = (at: number) => (at - dayStart(boardDateKey(at))) / HOUR

const TODAY = boardDateKey(NOW)

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

type Run = {
  game: GameSlug
  score: number
  startAt: number
  /** When the score landed: the board's `at`. */
  at: number
  durationMs: number
  device: DeviceType
  records: RunRecord[]
  /** Played from a bracket's match card, which posts nothing to the record books. */
  inMatch?: boolean
}

type Player = {
  tag: string
  accountId: string
  email: string
  avatarId: string
  /** 0 casual … 1 the best on the site. */
  skill: number
  /** 0 rare … 1 daily. */
  activity: number
  device: DeviceType
  /** Most loved first. */
  favorites: GameSlug[]
  /** Skill in each game: better at some than others, and at the ones they like. */
  aptitude: Record<string, number>
  joinedAt: number
  /** When they stopped coming back, or never. */
  quitAt: number
  /** The hour they usually play, in the board's zone. */
  hour: number
  practice: Record<string, number>
  runs: Run[]
}

/** A time to play, on a day, a little before `NOW` if the day is today. */
function timeOnDay(key: number, hour: number, notBefore = 0): number | null {
  let at = Math.max(dayStart(key) + hour * HOUR, notBefore)
  if (key === TODAY) {
    const latest = NOW - 25 * MINUTE
    if (at > latest) {
      const earliest = Math.max(dayStart(key) + 7 * HOUR, notBefore)
      if (earliest >= latest) return null
      at = between(earliest, latest)
    }
  }
  return at
}

function makePlayers(existing: Set<string>): Player[] {
  const tags = TAGS.filter((t) => !existing.has(t))
  return tags.map((tag, i) => {
    // A few are very good, a fifth are strong, half are regulars, the rest
    // casual. The very good sit just above the strong rather than in a class
    // of their own, so nobody runs away with a board.
    const u = rand()
    const skill =
      u < 0.05 ? between(0.84, 0.93) : u < 0.25 ? between(0.64, 0.84) : u < 0.75 ? between(0.36, 0.64) : between(0.1, 0.36)
    // The keen ones tend to be the good ones.
    const activity = clamp(0.25 + 0.55 * Math.pow(rand(), 1.3) + (skill - 0.5) * 0.3 + gauss() * 0.08, 0.06, 1)
    const favorites = shuffle(SEEDED_GAMES).slice(0, 2 + Math.floor(rand() * 5))
    // Nobody is equally good at everything, and everyone is best at their own
    // game: only a player's main game reaches the top of the range, so each
    // board has its own champion rather than one player topping them all.
    const aptitude: Record<string, number> = {}
    for (const g of SEEDED_GAMES) {
      const fav = favorites.indexOf(g)
      aptitude[g] = clamp(skill + gauss() * 0.14 + (fav === 0 ? 0.07 : fav > 0 ? 0.03 : 0), 0.03, fav === 0 ? 0.96 : 0.9)
    }
    const r = rand()
    const hour = r < 0.7 ? between(18.5, 22.5) : r < 0.85 ? between(11.8, 13.5) : between(7.5, 17)
    // More joined lately than long ago.
    let joinDay = boardDateKey(NOW - Math.floor(1 + 100 * Math.pow(rand(), 1.25)) * DAY)
    let joinedAt = timeOnDay(joinDay, hour)
    if (joinedAt == null) {
      joinDay = addDays(TODAY, -1)
      joinedAt = timeOnDay(joinDay, hour)!
    }
    joinedAt -= between(3, 25) * MINUTE
    const quitAt = chance(0.24) ? joinedAt + (NOW - joinedAt) * between(0.25, 0.85) : Number.POSITIVE_INFINITY
    return {
      tag,
      accountId: `seed-acct-${(i + 1).toString().padStart(3, '0')}`,
      email: `${tag.toLowerCase()}@seed.skermix.dev`,
      avatarId: randomAvatarId(rand),
      skill,
      activity,
      device: pick(DEVICES),
      favorites,
      aptitude,
      joinedAt,
      quitAt,
      hour,
      practice: {},
      runs: [],
    }
  })
}

/* ---------- playing ---------- */

/** Where a player is in a game: their aptitude, less while they are still learning it. */
function ability(p: Player, game: GameSlug) {
  const practice = p.practice[game] ?? 0
  return (p.aptitude[game] ?? p.skill) * (0.7 + 0.3 * (1 - Math.exp(-practice / 18)))
}

/** How many goes in a sitting: one, often two or three, now and then a long one. */
function goesInSitting(p: Player) {
  let n = 1
  while (n < 9 && chance(0.38 + 0.26 * p.activity)) n++
  return n
}

function overlaps(p: Player, from: number, to: number) {
  return p.runs.find((r) => r.startAt < to && r.at > from)
}

/** Play one run from `startAt`, or nothing if it would end in the future. */
function playOne(p: Player, game: GameSlug, startAt: number, form: number, inMatch = false): Run | null {
  const r = playRun(game, ability(p, game) * form, rand)
  const at = startAt + r.durationMs
  if (at > NOW - 2 * MINUTE) return null
  const run: Run = {
    game,
    score: r.score,
    startAt,
    at,
    durationMs: r.durationMs,
    device: chance(0.9) ? p.device : pick(DEVICES),
    records: r.records,
    ...(inMatch ? { inMatch } : {}),
  }
  p.runs.push(run)
  p.practice[game] = (p.practice[game] ?? 0) + 1
  return run
}

type Sitting = { at: number; games: GameSlug[]; goes?: number }

/** A sitting: a few goes at each game, one after another. */
function playSitting(p: Player, s: Sitting, notBefore: number): number {
  let t = Math.max(s.at, notBefore)
  const form = between(0.94, 1.05)
  for (const game of s.games) {
    const goes = s.goes ?? goesInSitting(p)
    for (let i = 0; i < goes; i++) {
      const run = playOne(p, game, t, form)
      if (!run) return t
      t = run.at + between(6, 50) * 1000
    }
    t += between(1, 12) * MINUTE
  }
  return t
}

/** The days someone plays: habits run in streaks, and weekends pull people back. */
function playDays(p: Player): number[] {
  const out: number[] = []
  const stay = 0.2 + 0.75 * Math.pow(p.activity, 0.8)
  const start = 0.03 + 0.4 * Math.pow(p.activity, 1.4)
  let played = true
  for (let key = boardDateKey(p.joinedAt); key <= TODAY; key = nextDay(key)) {
    if (dayStart(key) > p.quitAt) break
    if (played) out.push(key)
    const weekend = [0, 6].includes(weekday(nextDay(key)))
    played = chance(Math.min(0.97, (played ? stay : start) + (weekend ? 0.06 : 0)))
  }
  return out
}

/**
 * Which games tonight. The keen have a game they play every time they sit
 * down; after that it is mostly favourites, and the day's events pull a
 * little. The daily is on the front page, so a good share of people play it.
 */
function chooseGames(p: Player, key: number, events: Tournament[]): GameSlug[] {
  const pull = eventPull(events, key)
  const count = 1 + (chance(0.38) ? 1 : 0) + (chance(0.12) ? 1 : 0)
  const weights = SEEDED_GAMES.map((g) => {
    const fav = p.favorites.indexOf(g)
    const base = fav >= 0 ? ([6, 4, 3, 2.4, 2, 1.6][fav] ?? 1.5) : 0.25
    return base * (pull.get(g) ?? 1)
  })
  const out: GameSlug[] = []
  if (chance(0.3 + 0.4 * p.activity)) out.push(p.favorites[0]!)
  while (out.length < count) {
    const total = weights.reduce((sum, w, i) => sum + (out.includes(SEEDED_GAMES[i]!) ? 0 : w), 0)
    let roll = rand() * total
    for (let i = 0; i < SEEDED_GAMES.length; i++) {
      const g = SEEDED_GAMES[i]!
      if (out.includes(g)) continue
      roll -= weights[i]!
      if (roll <= 0) {
        out.push(g)
        break
      }
    }
  }
  const noon = dayStart(key) + 12 * HOUR
  const daily = events.find((t) => t.cadence === 'daily' && noon >= t.startsAt && noon < t.endsAt)
  const featured = daily?.games[0]
  if (featured && !out.includes(featured) && chance(0.4 + 0.3 * p.activity)) out.push(featured)
  return out
}

/* ---------- events ---------- */

/** The arcade's own events still on the list: today's daily and the two before, this week's and last. */
function officialEvents(): Tournament[] {
  const out: Tournament[] = []
  for (let back = 2; back >= 0; back--) out.push(buildDailyEvent(dayStart(addDays(TODAY, -back)) + 12 * HOUR))
  const thisWeek = weekStartKey(NOW)
  out.push(buildWeeklyEvent(dayStart(addDays(thisWeek, -7)) + 36 * HOUR))
  out.push(buildWeeklyEvent(dayStart(thisWeek) + 36 * HOUR))
  return out
}

/** How much an event pulls its games into a player's evening on `key`. */
function eventPull(events: Tournament[], key: number): Map<GameSlug, number> {
  const pull = new Map<GameSlug, number>()
  const noon = dayStart(key) + 12 * HOUR
  for (const t of events) {
    if (noon < t.startsAt || noon >= t.endsAt) continue
    for (const g of t.games) pull.set(g, (pull.get(g) ?? 1) * (t.cadence === 'daily' ? 2.5 : 1.6))
  }
  return pull
}

type HostedPlan = {
  t: Tournament
  roster: Player[]
  /** Goes per game per sitting; unlimited ladders play what they like. */
  goes: number | null
}

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(rand() * chars.length)]
  return code
}

/** The most recent `weekdayWanted` at least `minDaysAgo` back. */
function lastWeekday(weekdayWanted: number, minDaysAgo: number) {
  let key = addDays(TODAY, -minDaysAgo)
  while (weekday(key) !== weekdayWanted) key = addDays(key, -1)
  return key
}

/**
 * Private events hosted by players: three finished, two running. Each roster
 * is players who were around for the whole of it, and each member sits down
 * to play it once or twice while it runs.
 */
function hostedScoreEvents(players: Player[]): HostedPlan[] {
  const defs: {
    title: string
    games: GameSlug[]
    startsAt: number
    hours: number
    size: number
    tries: number
  }[] = [
    {
      title: 'Friday Night Triple',
      games: ['stacker', 'pop', 'fireflies'],
      startsAt: dayStart(lastWeekday(5, 15)) + 19 * HOUR,
      hours: 48,
      size: 14,
      tries: 3,
    },
    {
      title: 'Office League · Week 2',
      games: ['asteroids', 'pellets'],
      startsAt: dayStart(lastWeekday(1, 7)) + 9 * HOUR,
      hours: 96,
      size: 11,
      tries: 2,
    },
    {
      title: 'Snake Sunday',
      games: ['snake'],
      startsAt: dayStart(lastWeekday(0, 2)) + 10 * HOUR,
      hours: 24,
      size: 9,
      tries: 5,
    },
    {
      title: 'Lunch Break Ladder',
      games: ['pop', 'centroid', 'fireflies'],
      startsAt: dayStart(addDays(TODAY, -1)) + 11.5 * HOUR,
      hours: 72,
      size: 12,
      tries: 0,
    },
    {
      title: 'Patriot Standoff',
      games: ['patriot'],
      startsAt: Math.min(dayStart(TODAY) + 9 * HOUR, NOW - 3 * HOUR),
      hours: 24,
      size: 7,
      tries: 3,
    },
  ]
  const used = new Set<string>()
  const plans: HostedPlan[] = []
  for (const d of defs) {
    const endsAt = d.startsAt + d.hours * HOUR
    const pool = shuffle(
      players.filter(
        (p) => p.joinedAt < d.startsAt - DAY && p.quitAt > Math.min(endsAt, NOW) && p.activity > 0.3,
      ),
    ).sort((a, b) => Number(used.has(a.tag)) - Number(used.has(b.tag)))
    const roster = pool.slice(0, d.size)
    for (const p of roster) used.add(p.tag)
    const host = roster[0]!
    const multi = d.games.length > 1
    const t: Tournament = {
      id: sid('ev'),
      title: d.title,
      blurb: multi
        ? 'Place points across games — highest total wins.'
        : d.tries
          ? `${d.tries} tries. Best score wins.`
          : 'Best score wins.',
      games: d.games,
      startsAt: d.startsAt,
      endsAt,
      official: false,
      cadence: null,
      format: multi ? 'place-points' : d.tries ? 'attempt-limited' : 'open',
      kind: 'scores',
      rules: { maxAttempts: d.tries, maxPlayers: 0, scoring: 'best' },
      createdBy: { accountId: host.accountId, email: host.email },
      visibility: 'private',
      inviteCode: inviteCode(),
      players: [],
      scores: [],
    }
    plans.push({ t, roster, goes: d.tries ? null : 0 })
  }
  return plans
}

/** When each roster member sits down to play a hosted event, split across one or two sittings. */
function hostedSittings(plan: HostedPlan): Map<string, Sitting[]> {
  const { t, roster } = plan
  const out = new Map<string, Sitting[]>()
  const until = Math.min(t.endsAt, NOW - 30 * MINUTE)
  const tries = t.rules?.maxAttempts ?? 0
  for (const p of roster) {
    // A few never get round to it.
    if (chance(0.12)) continue
    const sittings = chance(0.4) ? 2 : 1
    const list: Sitting[] = []
    let left = tries
    for (let i = 0; i < sittings; i++) {
      const lo = t.startsAt + 20 * MINUTE + ((until - t.startsAt) * i) / sittings
      const hi = t.startsAt + ((until - t.startsAt) * (i + 1)) / sittings - 20 * MINUTE
      if (hi <= lo) continue
      // Near their usual hour when the window allows it.
      let at = between(lo, hi)
      for (let k = 0; k < 6; k++) {
        const guess = between(lo, hi)
        if (Math.abs(hourOf(guess) - p.hour) < Math.abs(hourOf(at) - p.hour)) at = guess
      }
      const goes = tries ? (i === sittings - 1 ? left : Math.ceil(left / 2)) : 1 + Math.floor(rand() * 4)
      left -= tries ? goes : 0
      if (goes > 0) list.push({ at, games: shuffle(t.games), goes })
    }
    out.set(p.tag, list)
  }
  return out
}

/** Seat everyone who played, and file their runs the way the API would have. */
function fileRuns(t: Tournament, entrants: { p: Player; joinedAt: number }[]) {
  const maxAttempts = t.rules?.maxAttempts ?? 0
  const limited = t.format !== 'open' && maxAttempts > 0
  for (const { p, joinedAt } of entrants) {
    const seat: TournamentPlayer = { id: sid('seat'), name: p.tag, joinedAt, accountId: p.accountId }
    t.players.push(seat)
    const runs = p.runs.filter(
      (r) => !r.inMatch && t.games.includes(r.game) && r.startAt >= joinedAt && r.at < t.endsAt,
    )
    for (const game of t.games) {
      const mine = runs.filter((r) => r.game === game).sort((a, b) => a.at - b.at)
      if (t.format === 'open') {
        // An open event keeps each player's best, and nothing else.
        const best = mine.reduce<Run | null>((b, r) => (!b || r.score > b.score ? r : b), null)
        if (best && best.score > 0) t.scores.push({ playerId: seat.id, game, score: best.score, at: best.at })
        continue
      }
      const counted = limited ? mine.slice(0, maxAttempts) : mine
      counted.forEach((r, i) => {
        if (r.score > 0) t.scores.push({ playerId: seat.id, game, score: r.score, at: r.at, attempt: i + 1 })
      })
    }
  }
}

/**
 * A weekly Triple is won by placing on all three games, so the people who
 * mean to play it sit down to each of them some time in the week. This week's
 * is still running, so some of them have a game still to go.
 */
function weeklySittings(t: Tournament, players: Player[]): { entrants: Set<string>; sittings: Map<string, Sitting[]> } {
  const entrants = new Set<string>()
  const sittings = new Map<string, Sitting[]>()
  const until = Math.min(t.endsAt, NOW - 30 * MINUTE)
  const running = t.endsAt > NOW
  for (const p of players) {
    const from = Math.max(t.startsAt, p.joinedAt)
    const to = Math.min(until, p.quitAt)
    if (p.activity < 0.2 || to - from < DAY || !chance(0.3 + 0.35 * p.activity)) continue
    entrants.add(p.tag)
    const list: Sitting[] = []
    for (const game of t.games) {
      if (running && chance(0.3)) continue
      const key = boardDateKey(between(from, to))
      const at = timeOnDay(key, clamp(p.hour + gauss(), 7, 23.6), from)
      if (at != null && at < to) list.push({ at, games: [game] })
    }
    sittings.set(p.tag, list)
  }
  return { entrants, sittings }
}

/** The arcade's events: whoever played its games while it ran, and chose to join. */
function fillOfficial(t: Tournament, players: Player[], meant: Set<string> = new Set()) {
  const rate = t.cadence === 'weekly' ? 0.25 : 0.75
  const entrants: { p: Player; joinedAt: number }[] = []
  for (const p of players) {
    const first = p.runs
      .filter((r) => !r.inMatch && t.games.includes(r.game) && r.startAt >= t.startsAt && r.at < t.endsAt)
      .sort((a, b) => a.startAt - b.startAt)[0]
    if (!first || !chance(meant.has(p.tag) ? 0.95 : rate)) continue
    entrants.push({ p, joinedAt: Math.max(t.startsAt + MINUTE, first.startAt - between(1, 25) * MINUTE) })
  }
  fileRuns(t, entrants)
}

/** Brackets: one finished, one halfway through, one still filling. */
function brackets(players: Player[]): Tournament[] {
  const out: Tournament[] = []
  const regulars = (from: number) =>
    shuffle(players.filter((p) => p.joinedAt < from - DAY && p.quitAt > NOW && p.activity > 0.35))

  const make = (
    title: string,
    game: GameSlug,
    startsAt: number,
    size: number,
    rules: NonNullable<Tournament['rules']>,
    seated: Player[],
  ): Tournament => ({
    id: sid('ev'),
    title,
    blurb: `${rules.elimination === 'double' ? 'Double' : 'Single'}-elim bracket — higher score wins each match. ${
      title.split(' ')[0]
    }.`,
    games: [game],
    startsAt,
    endsAt: startsAt,
    official: false,
    cadence: null,
    format: 'single-run',
    kind: 'bracket',
    rules: { ...rules, maxPlayers: size, scoring: 'best', unlimitedDuration: true },
    createdBy: { accountId: seated[0]!.accountId, email: seated[0]!.email },
    visibility: 'private',
    inviteCode: inviteCode(),
    players: seated.map((p) => ({
      id: sid('seat'),
      name: p.tag,
      joinedAt: startsAt + Math.floor(rand() * 5 * HOUR),
      accountId: p.accountId,
    })),
    scores: [],
  })

  // Finished: sixteen, double elimination, a round every twelve hours.
  {
    const startsAt = dayStart(addDays(TODAY, -9)) + 17 * HOUR
    const t = make('Stacker Sixteen', 'stacker', startsAt, 16, { maxAttempts: 1, roundPlayHours: 12, elimination: 'double' }, regulars(startsAt).slice(0, 16))
    lockBracket(t, startsAt + 6 * HOUR)
    playBracket(t, players, NOW, null)
    maybeEndWhenBracketFinished(t, Math.max(...t.scores.map((s) => s.at)) + 5 * MINUTE)
    out.push(t)
  }

  // Running: eight, single elimination, the semi-finals being played now.
  {
    const startsAt = NOW - 40 * HOUR
    const t = make('Asteroids Cup', 'asteroids', startsAt, 8, { maxAttempts: 2, roundPlayHours: 24, elimination: 'single' }, regulars(startsAt).slice(0, 8))
    lockBracket(t, startsAt + 2 * HOUR)
    playBracket(t, players, NOW - 20 * MINUTE, 2)
    for (const m of t.bracket?.matches ?? []) {
      if (!m.winnerId && m.playerIds[0] && m.playerIds[1] && (m.playEndsAt ?? 0) <= NOW + HOUR) {
        m.playEndsAt = NOW + between(3, 9) * HOUR
      }
    }
    out.push(t)
  }

  // Filling: six of eight seats taken, no draw yet.
  {
    const startsAt = NOW - 2 * DAY
    const t = make('Pellets Eight', 'pellets', startsAt, 8, { maxAttempts: 1, roundPlayHours: 24, elimination: 'single' }, regulars(startsAt).slice(0, 6))
    for (const seat of t.players) seat.joinedAt = Math.min(seat.joinedAt, NOW - HOUR)
    out.push(t)
  }
  return out
}

/**
 * Play a locked bracket forward a round at a time. Each seated player plays
 * their match's attempts inside its clock, then the bracket decides what it
 * can and starts the next clocks from the last run. With `lastRound`, the
 * matches of that round are left part-played, each with a go still owed on
 * both sides or with one side not in yet, so none of them can be called.
 */
function playBracket(t: Tournament, players: Player[], until: number, lastRound: number | null) {
  const byName = new Map(players.map((p) => [p.tag, p]))
  const maxAttempts = t.rules?.maxAttempts ?? 1
  const windowMs = (t.rules?.roundPlayHours ?? 24) * HOUR
  for (let guard = 0; guard < 40 && !bracketHasChampion(t); guard++) {
    const open = (t.bracket?.matches ?? []).filter(
      (m) => !m.winnerId && !m.void && m.playerIds[0] && m.playerIds[1] && m.playEndsAt != null,
    )
    if (!open.length) break
    let latest = 0
    let stop = false
    for (const [index, m] of open.entries()) {
      const partial = lastRound != null && m.round >= lastRound
      if (partial) stop = true
      const armedAt = m.playEndsAt! - windowMs
      const game = (bracketGamesForRound(t, m.round)[0] ?? t.games[0]!) as GameSlug
      m.playerIds.forEach((pid, side) => {
        const attempts = partial ? (index === 0 || side === 0 ? maxAttempts - 1 : 0) : maxAttempts
        const seat = t.players.find((s) => s.id === pid)
        const p = seat ? byName.get(seat.name) : null
        if (!seat || !p || attempts < 1) return
        let at = armedAt + between(0.3, 0.7) * windowMs * (partial ? 0.5 : 1)
        for (let a = 1; a <= attempts; a++) {
          if (at >= until) break
          const clash = overlaps(p, at, at + 6 * MINUTE)
          if (clash) at = clash.at + between(2, 10) * MINUTE
          const run = playOne(p, game, at, between(0.96, 1.06), true)
          if (!run || run.at > Math.min(until, m.playEndsAt!)) {
            if (run) p.runs.pop()
            break
          }
          t.scores.push({ playerId: pid!, game, score: run.score, at: run.at, attempt: a, matchId: m.id })
          latest = Math.max(latest, run.at)
          at = run.at + between(1, 20) * MINUTE
        }
      })
    }
    if (stop) break
    resolveReadyMatches(t, maxAttempts)
    armMatchClocks(t, latest + between(1, 15) * MINUTE)
  }
}

/* ---------- record books ---------- */

type RecordRow = typeof recordScores.$inferInsert

/**
 * Everything the runs posted to the record books, kept the way the API keeps
 * it: a value is stored only when it beats the player's own best for the day,
 * the week, the month or all time, as of the moment it was posted.
 */
function recordBooks(players: Player[]): RecordRow[] {
  const rows: RecordRow[] = []
  const periods: Period[] = ['all', 'daily', 'weekly', 'monthly']
  for (const p of players) {
    const books = new Map<string, LeaderboardEntry[]>()
    const post = (game: GameSlug, recordId: string, value: number, at: number, device: DeviceType) => {
      const def = getRecordDef(game, recordId)
      if (!def) return
      const key = `${game}::${recordId}`
      const mine = books.get(key) ?? []
      const better = (a: number, b: number) => (def.direction === 'lower' ? a < b : a > b)
      const improves = (period: Period) => {
        const pool = filterByPeriod(mine, period, at)
        return !pool.length || pool.every((e) => better(value, e.score))
      }
      if (!periods.some(improves)) return
      const entry: LeaderboardEntry = { id: sid('rec'), name: p.tag, score: value, at, device }
      mine.push(entry)
      books.set(key, mine)
      rows.push({ ...entry, game, recordId })
    }
    const days = new Map<GameSlug, number[]>()
    const streak = new Map<GameSlug, number>()
    for (const run of p.runs) {
      if (!run.inMatch) {
        for (const r of run.records) post(run.game, r.recordId, r.value, run.startAt + r.atMs, run.device)
      }
      // After the board has the run: the streak books, counted as the API counts them.
      const history = days.get(run.game) ?? []
      history.push(run.at)
      days.set(run.game, history)
      const inARow = computePlayDaysStreak(history, run.at)
      if (inARow >= 2) post(run.game, PLAY_DAYS_STREAK_ID, inARow, run.at, run.device)
      const over = run.score >= SCORE_STREAK_THRESHOLDS[run.game] ? (streak.get(run.game) ?? 0) + 1 : 0
      streak.set(run.game, over)
      if (over >= 2) post(run.game, THRESHOLD_STREAK_ID, over, run.at, run.device)
    }
  }
  return rows
}

/* ---------- writing ---------- */

/**
 * The database, or one transaction on it. The world is written in a single
 * transaction, so the site sees the old one or the new one and never half of
 * either, and a run that fails part way leaves nothing behind.
 */
type Db = Pick<ReturnType<typeof db>, 'select' | 'insert' | 'update' | 'delete'>

async function insertRows<T extends object>(d: Db, table: Parameters<Db['insert']>[0], rows: T[]) {
  const chunk = 250
  for (let i = 0; i < rows.length; i += chunk) {
    await d.insert(table).values(rows.slice(i, i + chunk) as never)
  }
}

/** Remove what this script added before, and nothing else. */
async function clearSeed(d: Db) {
  await d.delete(leaderboardScores).where(like(leaderboardScores.id, 'seed-%'))
  await d.delete(recordScores).where(like(recordScores.id, 'seed-%'))
  await d.delete(tournamentsTable).where(like(tournamentsTable.id, 'seed-%'))
  await d
    .delete(trophyAwards)
    .where(or(inArray(trophyAwards.name, [...TAGS]), like(trophyAwards.eventId, 'seed-%')))
  await d.delete(friendships).where(like(friendships.id, 'seed-%'))
  await d.delete(friendRequests).where(like(friendRequests.id, 'seed-%'))
  await d.delete(groupMembers).where(like(groupMembers.groupId, 'seed-%'))
  await d.delete(groups).where(like(groups.id, 'seed-%'))
  await d.delete(directedInvites).where(like(directedInvites.id, 'seed-%'))
  await d.delete(nameClaims).where(like(nameClaims.accountId, 'seed-acct-%'))
  await d.delete(accounts).where(like(accounts.email, '%@seed.skermix.dev'))
  // The arcade's own events keep their real seats and lose the seeded ones:
  // from their tables, and from an event still written the old way, with its
  // roster and runs in its JSON.
  const officialRows = await d.select().from(tournamentsTable).where(eq(tournamentsTable.official, true))
  const officialIds = officialRows.map((row) => row.id)
  if (officialIds.length) {
    await d
      .delete(tournamentScores)
      .where(and(inArray(tournamentScores.tournamentId, officialIds), like(tournamentScores.playerId, 'seed-%')))
    await d
      .delete(tournamentPlayers)
      .where(and(inArray(tournamentPlayers.tournamentId, officialIds), like(tournamentPlayers.id, 'seed-%')))
  }
  for (const row of officialRows) {
    const t = row.data as Partial<Tournament>
    const players = Array.isArray(t.players) ? t.players : null
    const scores = Array.isArray(t.scores) ? t.scores : null
    const seeded = new Set((players ?? []).filter((s) => s.id.startsWith('seed-')).map((s) => s.id))
    const next = {
      ...t,
      ...(players ? { players: players.filter((s) => !seeded.has(s.id)) } : {}),
      ...(scores ? { scores: scores.filter((s) => !seeded.has(s.playerId) && !s.playerId.startsWith('seed-')) } : {}),
      // A running API reads a changed event again, rows and all: this is the change it sees.
      rowsChangedAt: Date.now(),
    }
    await d.update(tournamentsTable).set({ data: next as never }).where(eq(tournamentsTable.id, row.id))
  }
}

const EVERY_TABLE = {
  accounts,
  sessions,
  magic_links: magicLinks,
  name_claims: nameClaims,
  leaderboard_scores: leaderboardScores,
  game_runs: gameRuns,
  run_claims: runClaims,
  record_scores: recordScores,
  tournaments: tournamentsTable,
  tournament_players: tournamentPlayers,
  tournament_scores: tournamentScores,
  groups,
  group_members: groupMembers,
  directed_invites: directedInvites,
  friend_requests: friendRequests,
  friendships,
  trophy_awards: trophyAwards,
  trophy_cursor: trophyCursor,
  name_bans: nameBans,
  score_flags: scoreFlags,
  app_meta: appMeta,
  notifications,
  push_subscriptions: pushSubscriptions,
  push_ledger: pushLedger,
  challenges,
  challenge_results: challengeResults,
}

/** Every row of every table, to a file, before anything is removed. */
async function backUp(): Promise<string> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backups')
  fs.mkdirSync(dir, { recursive: true })
  const out: Record<string, unknown[]> = {}
  for (const [name, table] of Object.entries(EVERY_TABLE)) {
    out[name] = await db().select().from(table as never)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `world-${dbTarget().branch}-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(out))
  const counts = Object.entries(out)
    .map(([name, rows]) => `${name} ${rows.length}`)
    .join(', ')
  console.log(`  ${counts}`)
  return file
}

/**
 * Every score, record, event, challenge, trophy, group, friend and
 * notification, for everyone. Accounts, sign-ins, tags, bans and push
 * subscriptions stay, so nobody is signed out and every tag keeps its owner.
 */
async function wipeGameData(d: Db) {
  for (const table of [
    // A challenge names a saved run, and every run is about to go.
    challengeResults,
    challenges,
    runClaims,
    gameRuns,
    scoreFlags,
    leaderboardScores,
    recordScores,
    tournamentsTable,
    groupMembers,
    groups,
    directedInvites,
    friendRequests,
    friendships,
    trophyAwards,
    notifications,
    pushLedger,
  ]) {
    await d.delete(table)
  }
  await d
    .insert(trophyCursor)
    .values({ id: 'default', weeklyInitialized: false, monthlyInitialized: false })
    .onConflictDoUpdate({ target: trophyCursor.id, set: { weeklyInitialized: false, monthlyInitialized: false } })
}

async function seedAccounts(d: Db, players: Player[]) {
  await insertRows(
    d,
    accounts,
    players.map((p) => ({ id: p.accountId, email: p.email, createdAt: Math.round(p.joinedAt), plan: 'free', googleSub: null })),
  )
  await insertRows(
    d,
    nameClaims,
    players.map((p) => ({
      name: p.tag,
      token: `seed-${p.tag.toLowerCase()}-${Math.floor(rand() * 36 ** 8).toString(36)}`,
      claimedAt: Math.round(p.joinedAt),
      accountId: p.accountId,
      avatarId: p.avatarId,
    })),
  )
}

/* ---------- friends and groups ---------- */

async function seedSocial(d: Db, players: Player[]) {
  const pairs = new Set<string>()
  const rows: (typeof friendships.$inferInsert)[] = []
  const link = (a: Player, b: Player) => {
    if (a === b) return
    const [x, y] = a.accountId < b.accountId ? [a, b] : [b, a]
    const key = `${x.accountId}|${y.accountId}`
    if (pairs.has(key)) return
    pairs.add(key)
    const since = Math.max(x.joinedAt, y.joinedAt)
    rows.push({ id: sid('fr'), accountIdA: x.accountId, accountIdB: y.accountId, createdAt: Math.round(between(since, NOW - HOUR)) })
  }
  // Everyone has a few friends, the keen ones more, and people who play the same games find each other.
  for (const p of players) {
    const n = Math.round(1 + p.activity * 6)
    const alike = players.filter((q) => q !== p && q.favorites.some((g) => p.favorites.includes(g)))
    for (const q of shuffle(alike).slice(0, Math.ceil(n * 0.7))) link(p, q)
    for (const q of shuffle(players).slice(0, Math.floor(n * 0.3))) link(p, q)
  }
  await insertRows(d, friendships, rows)

  const circles: { name: string; members: Player[] }[] = [
    { name: 'Thursday Crew', members: shuffle(players.filter((p) => p.activity > 0.4)).slice(0, 12) },
    { name: 'Office League', members: shuffle(players.filter((p) => p.hour < 18)).slice(0, 16) },
    { name: 'Night Owls', members: shuffle(players.filter((p) => p.hour >= 21)).slice(0, 10) },
    { name: 'Cousins', members: shuffle(players).slice(0, 7) },
    { name: 'Lunch Club', members: shuffle(players.filter((p) => p.hour >= 11.5 && p.hour < 14)).slice(0, 9) },
  ]
  let groupCount = 0
  for (const c of circles) {
    if (c.members.length < 3) continue
    const id = sid('group')
    const owner = c.members[0]!
    await d.insert(groups).values({ id, name: c.name, inviteCode: inviteCode(), createdByAccountId: owner.accountId })
    const opened = owner.joinedAt + between(0, Math.max(0, NOW - owner.joinedAt) * 0.4)
    await insertRows(
      d,
      groupMembers,
      c.members.map((m) => ({
        groupId: id,
        name: m.tag,
        joinedAt: Math.round(between(Math.max(opened, m.joinedAt), NOW - HOUR)),
      })),
    )
    groupCount += 1
  }
  return { friendships: rows.length, groups: groupCount }
}

/* ---------- trophies ---------- */

/** The moment a closed period's trophies would have gone out: just after it closed. */
function closedAt(period: string, key: number): number {
  if (period === 'weekly') return dayStart(addDays(key, 7)) + 7 * MINUTE
  const y = Math.floor(key / 100)
  const m = key % 100
  const next = m === 12 ? (y + 1) * 10_000 + 101 : y * 10_000 + (m + 1) * 100 + 1
  return dayStart(next) + 7 * MINUTE
}

async function seedTrophies(events: Tournament[]) {
  // Weekly and monthly: ranked from the boards as they now stand, the last
  // eight weeks and six months, stamped with when each period closed.
  await db()
    .insert(trophyCursor)
    .values({ id: 'default', weeklyInitialized: false, monthlyInitialized: false })
    .onConflictDoUpdate({ target: trophyCursor.id, set: { weeklyInitialized: false, monthlyInitialized: false } })
  await ensurePeriodTrophies(NOW)
  const awarded = await db()
    .select({ period: trophyAwards.period, periodKey: trophyAwards.periodKey })
    .from(trophyAwards)
    .where(inArray(trophyAwards.name, [...TAGS]))
  const keys = new Set(awarded.filter((a) => a.period !== 'event').map((a) => `${a.period}:${a.periodKey}`))
  for (const key of keys) {
    const [period, periodKey] = key.split(':') as [string, string]
    await db()
      .update(trophyAwards)
      .set({ awardedAt: Math.min(NOW, closedAt(period, Number(periodKey))) })
      .where(sql`${trophyAwards.period} = ${period} and ${trophyAwards.periodKey} = ${Number(periodKey)}`)
  }

  // Event wins: every event that is over.
  let wins = 0
  for (const t of events) {
    const winner = tournamentWinner(t, NOW)
    if (!winner) continue
    const top = computeStandings(t).find((row) => row.name === winner)
    const ok = await awardEventWin({
      eventId: t.id,
      eventTitle: t.title,
      periodKey: boardDateKey(t.startsAt),
      name: winner,
      score: top?.totalPoints ?? 0,
      games: t.games.length,
      awardedAt: Math.round(Math.min(NOW - MINUTE, t.endsAt + between(5, 90) * MINUTE)),
    })
    if (ok) wins += 1
  }
  return { periods: keys.size, wins }
}

/* ---------- main ---------- */

async function main() {
  loadDotEnv()
  const fresh = process.argv.includes('--fresh')
  const clearOnly = process.argv.includes('--clear')
  // After the .env is read, so the branch it names is the one we check.
  assertNotProduction(fresh ? 'wipe every board and rebuild the world' : 'rebuild the world')
  await runMigrations()
  const target = dbTarget()
  console.log(`Database: ${target.isProduction ? 'PRODUCTION' : target.branch} (${target.host})`)

  if (fresh || process.argv.includes('--backup')) {
    console.log('Backing up every table…')
    const file = await backUp()
    console.log(`  written to ${file}`)
  }
  const events = await db().transaction(async (tx) => {
    if (fresh) {
      console.log('Wiping game data…')
      await wipeGameData(tx)
    }
    console.log('Clearing the previous seed…')
    await clearSeed(tx)
    if (clearOnly) return null
    return buildWorld(tx)
  })
  if (!events) {
    console.log('Seed data removed.')
    return
  }

  // After the commit, from the boards as everyone now sees them.
  console.log('Handing out trophies…')
  const trophies = await seedTrophies(events)
  console.log(`  ${trophies.periods} weekly and monthly podiums, ${trophies.wins} event wins`)

  const wk = weekStartKey(NOW)
  const top = (await globalRanksForClosedPeriod('weekly', wk)).slice(0, 3)
  console.log(`This week so far (${wk}, month ${monthKey(NOW)}): ${top.map((r) => `${r.name} ${r.score}`).join(', ') || 'no scores'}`)
  console.log('Done.')
}

/** Play the world and write it: players, runs, record books, events, friends and groups. */
async function buildWorld(d: Db): Promise<Tournament[]> {
  const existing = new Set((await d.select({ name: nameClaims.name }).from(nameClaims)).map((r) => r.name))
  const players = makePlayers(existing)
  const official = officialEvents()
  const hosted = hostedScoreEvents(players)
  const sittingsFor = new Map<string, Sitting[]>()
  const addSittings = (from: Map<string, Sitting[]>) => {
    for (const [tag, list] of from) sittingsFor.set(tag, [...(sittingsFor.get(tag) ?? []), ...list])
  }
  for (const plan of hosted) addSittings(hostedSittings(plan))
  const meant = new Map<string, Set<string>>()
  for (const t of official.filter((e) => e.cadence === 'weekly')) {
    const { entrants, sittings } = weeklySittings(t, players)
    meant.set(t.id, entrants)
    addSittings(sittings)
  }

  console.log(`Playing ${players.length} players' days…`)
  for (const p of players) {
    const plan: Sitting[] = [...(sittingsFor.get(p.tag) ?? [])]
    for (const key of playDays(p)) {
      const at = timeOnDay(key, clamp(p.hour + gauss() * 1.2, 7, 23.6), p.joinedAt + between(1, 6) * MINUTE)
      if (at != null) plan.push({ at, games: chooseGames(p, key, official) })
      // The keenest come back later the same day now and then.
      if (at != null && p.activity > 0.7 && chance(0.2)) {
        const later = timeOnDay(key, Math.min(23.5, hourOf(at) + between(2, 5)), at + 2 * HOUR)
        if (later != null) plan.push({ at: later, games: chooseGames(p, key, official) })
      }
    }
    plan.sort((a, b) => a.at - b.at)
    let free = 0
    for (const s of plan) free = playSitting(p, s, free) + between(5, 30) * MINUTE
  }
  const draws = brackets(players)
  for (const p of players) p.runs.sort((a, b) => a.at - b.at)

  for (const plan of hosted) {
    // Everyone on the roster joined early; the ones who never got round to it just never played.
    const entrants = plan.roster.map((p) => {
      const first = p.runs.find(
        (r) => plan.t.games.includes(r.game) && r.startAt >= plan.t.startsAt && r.at < plan.t.endsAt,
      )
      const joined = first ? first.startAt - between(2, 40) * MINUTE : plan.t.startsAt + between(0.2, 6) * HOUR
      return { p, joinedAt: Math.round(clamp(joined, plan.t.startsAt + MINUTE, NOW - MINUTE)) }
    })
    fileRuns(plan.t, entrants)
  }
  for (const t of official) fillOfficial(t, players, meant.get(t.id))
  // The arcade's own events may already hold real players; they keep their seats.
  const officialIds = official.map((t) => t.id)
  const standing = officialIds.length
    ? await d.select().from(tournamentsTable).where(inArray(tournamentsTable.id, officialIds))
    : []
  const realSeats = officialIds.length
    ? await d
        .select()
        .from(tournamentPlayers)
        .where(inArray(tournamentPlayers.tournamentId, officialIds))
        .orderBy(tournamentPlayers.seq)
    : []
  const realRuns = officialIds.length
    ? await d
        .select()
        .from(tournamentScores)
        .where(inArray(tournamentScores.tournamentId, officialIds))
        .orderBy(tournamentScores.seq)
    : []
  for (const row of standing) {
    // An event's real players are in its tables, or in its JSON if it was written the old way.
    const old = row.data as Partial<Tournament>
    const t = official.find((e) => e.id === row.id)!
    const seats = [
      ...(Array.isArray(old.players) ? old.players : []),
      ...realSeats
        .filter((p) => p.tournamentId === row.id)
        .map((p) => ({ id: p.id, name: p.name, joinedAt: p.joinedAt, ...(p.accountId ? { accountId: p.accountId } : {}) })),
    ]
    const runs = [
      ...(Array.isArray(old.scores) ? old.scores : []),
      ...realRuns
        .filter((r) => r.tournamentId === row.id)
        .map((r) => ({
          id: r.id,
          playerId: r.playerId,
          game: r.game as GameSlug,
          score: r.score,
          at: r.at,
          ...(r.attempt != null ? { attempt: r.attempt } : {}),
          ...(r.matchId != null ? { matchId: r.matchId } : {}),
        })),
    ]
    t.players = [...seats, ...t.players]
    t.scores = [...runs, ...t.scores]
  }

  console.log('Creating accounts and tags…')
  await seedAccounts(d, players)

  console.log('Posting runs…')
  const scoreRows = players.flatMap((p) =>
    p.runs.map((r) => ({
      id: sid('lb'),
      game: r.game,
      name: p.tag,
      score: r.score,
      at: Math.round(r.at),
      device: r.device,
      durationMs: r.durationMs,
    })),
  )
  await insertRows(d, leaderboardScores, scoreRows)
  console.log(`  ${scoreRows.length} runs across ${SEEDED_GAMES.length} games`)

  console.log('Filling record books…')
  const records = recordBooks(players).map((r) => ({ ...r, at: Math.round(r.at) }))
  await insertRows(d, recordScores, records)
  console.log(`  ${records.length} record entries`)

  console.log('Running events…')
  const events = [...official, ...hosted.map((h) => h.t), ...draws]
  for (const t of events) {
    const row = {
      id: t.id,
      data: t as unknown as Record<string, unknown>,
      official: Boolean(t.official),
      cadence: t.cadence ?? null,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      visibility: t.visibility ?? (t.official ? 'public' : 'private'),
      inviteCode: t.inviteCode ?? null,
    }
    await d
      .insert(tournamentsTable)
      .values(row)
      .onConflictDoUpdate({ target: tournamentsTable.id, set: { ...row, id: undefined } })
  }
  for (const t of official) console.log(`  ${t.title} (${t.id}): ${t.players.length} players, ${t.scores.length} scores`)
  console.log(`  ${hosted.length} hosted events and ${draws.length} brackets`)

  console.log('Making friends…')
  const social = await seedSocial(d, players)
  console.log(`  ${social.friendships} friendships, ${social.groups} groups`)
  return events
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
