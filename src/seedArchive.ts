import { and, eq, inArray, like, or } from 'drizzle-orm'
import { pathToFileURL } from 'node:url'
import { ACECHASE_FIRST_DAY } from './courseNames.js'
import { closeDb, db } from './db/client.js'
import { assertNotProduction, refuseOnProduction } from './env.js'
import {
  appMeta,
  dailyHoleResults,
  holeResults,
  leaderboardScores,
  nameClaims,
  recordScores,
  sessions,
  trackLaps,
} from './db/schema.js'
import { holeDay, holeNumber, holeToday } from './holes.js'
import { HOTLAP_PACE_MS } from './hotlapPace.js'
import { TIME_SCORE_BASE, TRIES_SCORE_BASE } from './scoreLimits.js'
import { boardDateKey, dayStartMs, type DeviceType } from './store.js'
import { dayKeyOf, dayNumberOf, trackOfDay } from './trackLaps.js'

/*
 * The dailies' past days, played by the seeded world's players (seedWorld.ts), so the archives, each
 * track's and hole's own board and their record books have something in them to look at and test against:
 * Hot Lap and Ace Chase came after the world was seeded, and none of its players had played them.
 *
 * For each day of each daily before today, about half the seeded players play it on its day, onto the
 * day's board as a day's play goes on: Hot Lap a few laps each, around the day's blue car by their skill;
 * Ace Chase their first bullseye's tries. A few more play it after its day, onto the track's or hole's own
 * board (track_laps, hole_results). A seeded hole is never done in fewer than 3 tries, so there's a record
 * to take. Real players and today are never touched, and nor is a seeded account someone has signed in as
 * to test with (a session of its own): what it plays is theirs.
 *
 * At boot it runs once per database (app_meta `seed:archive-v1`), only where there's a seeded world, and
 * never on production unless ALLOW_PRODUCTION_WRITES says so (env.ts), as with every seed. By hand,
 * against the database in .env (restart the API after, which keeps a copy of the boards):
 *
 *   npm run seed:archive            the seeded players' past days, again (what it wrote before goes first)
 *   npm run seed:archive -- --clear what it wrote, gone
 *
 * Everything it writes is the seeded world's: board and lap rows are `seed-arch-…`, and results belong to
 * seeded accounts, so clearing or reseeding the world (seedWorld.ts) takes it too.
 */

const MARK = 'seed:archive-v1'
const ID = 'seed-arch-'
const HOUR = 3_600_000

type Seeded = { name: string; accountId: string; skill: number; keen: number; hour: number; device: DeviceType }

/** A string's 32-bit hash (FNV-1a). */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A small seeded random source, the same numbers for the same key. */
function randomFor(key: string): () => number {
  let a = hash(key) || 1
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A seeded player as the dailies see them, from their tag: the world keeps no skill in the tables, so it's
 * drawn again the way seedWorld.ts draws it (a few very good, a fifth strong, half regulars, the rest casual).
 */
function seededPlayer(name: string, accountId: string): Seeded {
  const rand = randomFor(`player:${name}`)
  const u = rand()
  const between = (a: number, b: number) => a + (b - a) * rand()
  const skill = u < 0.05 ? between(0.84, 0.93) : u < 0.25 ? between(0.64, 0.84) : u < 0.75 ? between(0.36, 0.64) : between(0.1, 0.36)
  const keen = Math.min(1, Math.max(0.1, 0.3 + 0.5 * rand() + (skill - 0.5) * 0.3))
  const d = rand()
  const device: DeviceType = d < 0.62 ? 'phone' : d < 0.9 ? 'desktop' : 'tablet'
  return { name, accountId, skill, keen, hour: 8 + Math.floor(rand() * 15), device }
}

/** Seeded accounts someone has signed in as, to test with: what they play is theirs, so the seed leaves them alone. */
async function inUse(): Promise<Set<string>> {
  const rows = await db().selectDistinct({ accountId: sessions.accountId }).from(sessions).where(like(sessions.accountId, 'seed-acct-%'))
  return new Set(rows.map((r) => r.accountId))
}

/** The seeded players the seed plays: every seeded tag, less those in use. */
async function seededPlayers(): Promise<Seeded[]> {
  const rows = await db()
    .select({ name: nameClaims.name, accountId: nameClaims.accountId })
    .from(nameClaims)
    .where(like(nameClaims.accountId, 'seed-acct-%'))
  const busy = await inUse()
  return rows.filter((r) => r.accountId && !busy.has(r.accountId)).map((r) => seededPlayer(r.name, r.accountId!))
}

/** A moment on a day, from its start: the player's usual hour, give or take. */
function onDay(key: number, player: Seeded, rand: () => number): number {
  const start = dayStartMs(key)
  const hour = Math.min(23.5, Math.max(7, player.hour + (rand() - 0.5) * 4))
  return start + Math.round(hour * HOUR + rand() * 20 * 60_000)
}

/** A moment after a day, up to now: when a player came back to it from the archive. */
function afterDay(key: number, now: number, rand: () => number): number {
  const from = dayStartMs(key) + 24 * HOUR + HOUR
  return Math.min(now - 10 * 60_000, from + Math.round(rand() * Math.max(0, now - from)))
}

const gauss = (rand: () => number) => (rand() + rand() + rand() - 1.5) / 0.5

/** A player's lap of a track, as a share of its blue car's: the best seeded players near 0.88, the casual near 1.25. */
function lapShare(player: Seeded, rand: () => number, lap: number): number {
  const base = 1.3 - 0.42 * player.skill + gauss(rand) * 0.02
  return Math.max(0.875, base + 0.05 * rand() - 0.012 * lap)
}

/** A player's first bullseye on a hole: never under 3 seeded tries, fewer the better they are. */
function holeTries(player: Seeded, rand: () => number): number {
  const mean = 1.2 + 7 * (1 - player.skill)
  return Math.min(24, 3 + Math.floor(-Math.log(1 - rand() * 0.999) * mean))
}

/** A hole's tries as letters, as Today's Hole keeps them: closer as it goes, the bullseye last. */
function holePattern(tries: number, rand: () => number): string {
  let out = ''
  for (let i = 0; i < tries - 1; i++) {
    const near = (i + 1) / tries
    const r = rand()
    out += r < 0.06 ? 'l' : r < 0.35 - near * 0.2 ? 'x' : r < 0.75 - near * 0.1 ? 'o' : 'i'
  }
  return `${out}b`
}

const dayOfKey = (key: number) =>
  `${Math.floor(key / 10_000)}-${String(Math.floor(key / 100) % 100).padStart(2, '0')}-${String(key % 100).padStart(2, '0')}`

async function insertAll<T extends object>(table: Parameters<ReturnType<typeof db>['insert']>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 250) {
    await db().insert(table).values(rows.slice(i, i + 250) as never).onConflictDoNothing()
  }
}

/**
 * Remove what this wrote: its board and lap rows, the seeded players' results on the dailies' holes, and
 * every seeded tag's track and hole records, which catch up with the boards again at the API's next start
 * (courseRecords.ts). A seeded account in use keeps its results, and its records come back from them.
 */
export async function clearArchiveSeed(): Promise<void> {
  const players = await seededPlayers()
  const accounts = players.map((p) => p.accountId)
  const tags = await db().select({ name: nameClaims.name }).from(nameClaims).where(like(nameClaims.accountId, 'seed-acct-%'))
  const names = tags.map((t) => t.name)
  await db().delete(leaderboardScores).where(like(leaderboardScores.id, `${ID}%`))
  await db().delete(trackLaps).where(like(trackLaps.id, `${ID}%`))
  for (let i = 0; i < accounts.length; i += 200) {
    const some = accounts.slice(i, i + 200)
    await db().delete(holeResults).where(inArray(holeResults.accountId, some))
    await db().delete(dailyHoleResults).where(inArray(dailyHoleResults.accountId, some))
  }
  for (let i = 0; i < names.length; i += 200) {
    await db()
      .delete(recordScores)
      .where(
        and(
          inArray(recordScores.game, ['hotlap', 'acechase']),
          or(like(recordScores.recordId, 'track-%'), like(recordScores.recordId, 'hole-%')),
          inArray(recordScores.name, names.slice(i, i + 200)),
        ),
      )
  }
}

/** The seeded players' past days on the dailies: what it wrote, in words. */
export async function seedArchive(now = Date.now()): Promise<string> {
  const players = await seededPlayers()
  if (!players.length) return 'no seeded world here, so nothing to play the past days'
  await clearArchiveSeed()
  const boards: (typeof leaderboardScores.$inferInsert)[] = []
  const laps: (typeof trackLaps.$inferInsert)[] = []
  const dayResults: (typeof dailyHoleResults.$inferInsert)[] = []
  const later: (typeof holeResults.$inferInsert)[] = []

  // Hot Lap: every day before today, on its track.
  const today = dayNumberOf(boardDateKey(now))
  for (let d = 1; d < today; d++) {
    const key = dayKeyOf(d)
    // A day's laps stay in its day: one that would run past midnight isn't driven.
    const dayEnd = dayStartMs(dayKeyOf(d + 1)) - 60_000
    const track = trackOfDay(d)
    const pace = HOTLAP_PACE_MS[track - 1]
    if (!pace) continue
    for (const player of players) {
      const rand = randomFor(`hotlap:${key}:${player.name}`)
      if (rand() < 0.2 + 0.45 * player.keen) {
        const count = 1 + Math.floor(rand() * 4)
        let at = onDay(key, player, rand)
        for (let lap = 0; lap < count && at < dayEnd; lap++) {
          const ms = Math.round((pace * lapShare(player, rand, lap)) / 10) * 10
          boards.push({ id: `${ID}hl-${key}-${player.name}-${lap}`, game: 'hotlap', name: player.name, score: TIME_SCORE_BASE - ms, at, device: player.device, durationMs: ms + 2_500 })
          at += ms + Math.round(20_000 + rand() * 90_000)
        }
      }
      // After its day, from the archive: a few who missed it, and a few back to beat their own.
      const back = randomFor(`hotlap-later:${key}:${player.name}`)
      if (back() < 0.12 + 0.08 * player.keen) {
        const count = 1 + Math.floor(back() * 3)
        let at = afterDay(key, now, back)
        for (let lap = 0; lap < count && at < now; lap++) {
          const ms = Math.round((pace * lapShare(player, back, lap + 2)) / 10) * 10
          laps.push({ id: `${ID}tl-${track}-${player.name}-${lap}`, game: 'hotlap', track, accountId: player.accountId, name: player.name, score: TIME_SCORE_BASE - ms, device: player.device, runId: null, durationMs: ms + 2_500, at })
          at += ms + Math.round(20_000 + back() * 90_000)
        }
      }
    }
  }

  // Ace Chase: every hole before today's.
  const holesToday = holeNumber(holeToday(now))
  for (let n = 1; n < holesToday; n++) {
    const day = holeDay(n)
    const key = Number(day.replace(/-/g, ''))
    for (const player of players) {
      const rand = randomFor(`acechase:${day}:${player.name}`)
      if (rand() < 0.2 + 0.45 * player.keen) {
        const tries = holeTries(player, rand)
        const at = onDay(key, player, rand)
        dayResults.push({ accountId: player.accountId, day, tries, pattern: holePattern(tries, rand), name: player.name, solvedAt: at })
        boards.push({ id: `${ID}ac-${day}-${player.name}`, game: 'acechase', name: player.name, score: TRIES_SCORE_BASE - tries, at, device: player.device })
      } else if (rand() < 0.22) {
        // Missed it on its day, played it later from the archive: their first bullseye goes on its board.
        const tries = holeTries(player, rand)
        const at = afterDay(key, now, rand)
        if (at < now) later.push({ accountId: player.accountId, game: 'acechase', day, name: player.name, tries, pattern: holePattern(tries, rand), device: player.device, at })
      }
    }
  }

  // Nothing from the future: a run of laps late on a day is cut off before now.
  const keep = <T extends { at?: number | null; solvedAt?: number | null }>(row: T) => ((row.at ?? row.solvedAt) ?? 0) < now
  await insertAll(leaderboardScores, boards.filter(keep))
  await insertAll(trackLaps, laps.filter(keep))
  await insertAll(dailyHoleResults, dayResults.filter(keep))
  await insertAll(holeResults, later.filter(keep))
  const days = today - 1
  const holes = holesToday - 1
  return `${players.length} seeded players: ${boards.filter((b) => b.game === 'hotlap').length} Hot Lap laps on ${days} past ${days === 1 ? 'day' : 'days'} and ${laps.length} since, ${dayResults.length} Ace Chase results on ${holes} past ${holes === 1 ? 'hole' : 'holes'} (${dayOfKey(Number(ACECHASE_FIRST_DAY.replace(/-/g, '')))} on) and ${later.length} since`
}

/**
 * At boot: the seeded players' past days, once per database. Not on production unless it's asked for there
 * (env.ts ALLOW_PRODUCTION_WRITES), as with every seed.
 */
export async function seedArchiveOnce(): Promise<void> {
  const done = await db().select().from(appMeta).where(eq(appMeta.key, MARK)).limit(1)
  if (done[0]) return
  if (refuseOnProduction('seed the dailies’ past days with the seeded players')) return
  const note = await seedArchive()
  const stamp = new Date().toISOString()
  await db().insert(appMeta).values({ key: MARK, value: stamp }).onConflictDoUpdate({ target: appMeta.key, set: { value: stamp } })
  console.log(`[seed archive] ${note}`)
}

// By hand: `npm run seed:archive` (or `-- --clear`), against the database in .env.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile()
  } catch {
    // No .env here: the environment has to say which database.
  }
  const clearing = process.argv.includes('--clear')
  assertNotProduction(clearing ? 'clear the seeded players’ past days' : 'seed the dailies’ past days')
  try {
    if (clearing) {
      await clearArchiveSeed()
      console.log('removed the seeded players’ past days on the dailies')
    } else {
      console.log(await seedArchive())
    }
    console.log('restart the API so its copy of the boards reads them')
  } finally {
    await closeDb()
  }
}
