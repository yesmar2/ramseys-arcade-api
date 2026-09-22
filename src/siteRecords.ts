import { db } from './db/client.js'
import { leaderboardScores } from './db/schema.js'
import { boardDateKey, previousBoardDateKey } from './store.js'

/**
 * Records for the whole site rather than one game.
 *
 * The per-game books ask how well somebody played. These ask how they played:
 * how often, how widely, how long they kept coming back. Nothing new is
 * recorded to answer them — every one falls out of the scores already on the
 * boards, because a score is a timestamped note that a person was here.
 *
 * All of them are lifetime. A record that resets every Monday is a leaderboard,
 * and the site already has those.
 */

export const SITE_RECORD_IDS = [
  'day-streak',
  'games-in-a-day',
  'runs-in-a-day',
  'days-played',
  'games-played',
  'boards-topped',
] as const
export type SiteRecordId = (typeof SITE_RECORD_IDS)[number]

export type SiteRecordDef = {
  id: SiteRecordId
  label: string
  /** One line on what earns a place, in the same voice as the game books. */
  blurb: string
  unit: 'days' | 'games' | 'runs' | 'boards'
}

export const SITE_RECORD_DEFS: Record<SiteRecordId, SiteRecordDef> = {
  'day-streak': {
    id: 'day-streak',
    label: 'Longest streak',
    blurb: 'Days in a row with a run on the board. Miss one and it starts again.',
    unit: 'days',
  },
  'games-in-a-day': {
    id: 'games-in-a-day',
    label: 'Most games in a day',
    blurb: 'Different cabinets played between one midnight and the next.',
    unit: 'games',
  },
  'runs-in-a-day': {
    id: 'runs-in-a-day',
    label: 'Busiest day',
    blurb: 'Most scores saved in a single day, whatever they were.',
    unit: 'runs',
  },
  'days-played': {
    id: 'days-played',
    label: 'Most days played',
    blurb: 'Days with at least one run on them, all time. Turning up counts.',
    unit: 'days',
  },
  'games-played': {
    id: 'games-played',
    label: 'Most games played',
    blurb: 'Cabinets you have put a score on. The whole arcade is the target.',
    unit: 'games',
  },
  'boards-topped': {
    id: 'boards-topped',
    label: 'Boards held',
    blurb: 'Games where the all-time top score is currently yours.',
    unit: 'boards',
  },
}

export type SiteRecordEntry = {
  name: string
  value: number
  /** The day a peak happened, where the record is about one day. */
  at: number | null
}

export type SiteRecordBoard = SiteRecordDef & { entries: SiteRecordEntry[] }

/**
 * Everything one player did, folded down as the rows go past.
 *
 * Built in a single pass because the alternative is six queries that have to
 * agree with each other about what a day is.
 */
type Tally = {
  days: Set<number>
  games: Set<string>
  /** Day key → runs that day, and the games seen in it. */
  byDay: Map<number, { runs: number; games: Set<string> }>
}

function emptyTally(): Tally {
  return { days: new Set(), games: new Set(), byDay: new Map() }
}

/** Longest run of consecutive days present, ever — not the one ending today. */
function bestStreak(days: Set<number>): number {
  const sorted = [...days].sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const day of sorted) {
    run = prev != null && previousBoardDateKey(day) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return best
}

function topOfDay(
  byDay: Tally['byDay'],
  pick: (entry: { runs: number; games: Set<string> }) => number,
): { value: number; at: number | null } {
  let value = 0
  let at: number | null = null
  for (const [day, entry] of byDay) {
    const n = pick(entry)
    if (n > value) {
      value = n
      at = day
    }
  }
  return { value, at }
}

const TOP_N = 10

function rank(
  rows: { name: string; value: number; at: number | null }[],
): SiteRecordEntry[] {
  return rows
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, TOP_N)
}

const CACHE_TTL_MS = 60_000
let cache: { at: number; key: string; boards: SiteRecordBoard[] } | null = null

export function invalidateSiteRecords() {
  cache = null
}

/**
 * Build every site record in one pass over the scores.
 *
 * Reads the whole score table, which is the right shape for a board that is
 * about lifetime habits and a table this size. If it ever stops being cheap,
 * the fold below is what moves into SQL — the shape of the answer would not
 * change.
 */
export async function siteRecords(
  scope?: { names: Set<string> } | null,
): Promise<SiteRecordBoard[]> {
  const key = scope ? [...scope.names].sort().join(',') : 'everyone'
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.boards
  }

  const rows = await db()
    .select({
      name: leaderboardScores.name,
      game: leaderboardScores.game,
      score: leaderboardScores.score,
      at: leaderboardScores.at,
    })
    .from(leaderboardScores)

  const tallies = new Map<string, Tally>()
  /** Game → the best score seen and who holds it, for "boards held". */
  const leaders = new Map<string, { name: string; score: number }>()

  for (const row of rows) {
    if (scope && !scope.names.has(row.name)) continue

    const leader = leaders.get(row.game)
    if (!leader || row.score > leader.score) {
      leaders.set(row.game, { name: row.name, score: row.score })
    }

    let tally = tallies.get(row.name)
    if (!tally) {
      tally = emptyTally()
      tallies.set(row.name, tally)
    }
    const day = boardDateKey(Number(row.at))
    tally.days.add(day)
    tally.games.add(row.game)
    const dayEntry = tally.byDay.get(day) ?? { runs: 0, games: new Set<string>() }
    dayEntry.runs += 1
    dayEntry.games.add(row.game)
    tally.byDay.set(day, dayEntry)
  }

  const heldByName = new Map<string, number>()
  for (const { name } of leaders.values()) {
    heldByName.set(name, (heldByName.get(name) ?? 0) + 1)
  }

  const streaks: SiteRecordEntry[] = []
  const gamesInDay: SiteRecordEntry[] = []
  const runsInDay: SiteRecordEntry[] = []
  const daysPlayed: SiteRecordEntry[] = []
  const gamesPlayed: SiteRecordEntry[] = []
  const boardsHeld: SiteRecordEntry[] = []

  for (const [name, tally] of tallies) {
    streaks.push({ name, value: bestStreak(tally.days), at: null })

    const games = topOfDay(tally.byDay, (d) => d.games.size)
    gamesInDay.push({ name, value: games.value, at: games.at })

    const runs = topOfDay(tally.byDay, (d) => d.runs)
    runsInDay.push({ name, value: runs.value, at: runs.at })

    daysPlayed.push({ name, value: tally.days.size, at: null })
    gamesPlayed.push({ name, value: tally.games.size, at: null })
    boardsHeld.push({ name, value: heldByName.get(name) ?? 0, at: null })
  }

  const boards: SiteRecordBoard[] = [
    { ...SITE_RECORD_DEFS['day-streak'], entries: rank(streaks) },
    { ...SITE_RECORD_DEFS['games-in-a-day'], entries: rank(gamesInDay) },
    { ...SITE_RECORD_DEFS['runs-in-a-day'], entries: rank(runsInDay) },
    { ...SITE_RECORD_DEFS['days-played'], entries: rank(daysPlayed) },
    { ...SITE_RECORD_DEFS['games-played'], entries: rank(gamesPlayed) },
    { ...SITE_RECORD_DEFS['boards-topped'], entries: rank(boardsHeld) },
  ]

  cache = { at: Date.now(), key, boards }
  return boards
}

/** Where one player stands on each site record, for their own stats page. */
export async function siteRecordStandingFor(
  rawName: string,
  scope?: { names: Set<string> } | null,
): Promise<Record<SiteRecordId, { value: number; rank: number | null }>> {
  const name = rawName.trim().slice(0, 12).toUpperCase()
  const boards = await siteRecords(scope)
  const out = {} as Record<SiteRecordId, { value: number; rank: number | null }>
  for (const board of boards) {
    const index = board.entries.findIndex((entry) => entry.name === name)
    out[board.id] = {
      value: index === -1 ? 0 : board.entries[index]!.value,
      rank: index === -1 ? null : index + 1,
    }
  }
  return out
}
