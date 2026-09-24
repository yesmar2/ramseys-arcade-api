import { allScores, boardDateKey, previousBoardDateKey } from './store.js'

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
 * agree with each other about what a day is. The rows come a game at a time,
 * so "which games" is a count and the game last counted, not a set.
 */
type Tally = {
  games: number
  lastGame: string
  /** Day key → runs that day, and the games seen in it: every day played. */
  byDay: Map<number, DayTally>
}

type DayTally = { runs: number; games: number; lastGame: string }

const TOP_N = 10

/** Ties go to the name first in the alphabet; one collator, as localeCompare would sort. */
const nameOrder = new Intl.Collator()

/** Whether a row with this value and name goes above one with those. */
function above(value: number, name: string, than: SiteRecordEntry) {
  return value > than.value || (value === than.value && nameOrder.compare(name, than.name) < 0)
}

/**
 * A board's top ten, kept as the players go past: most first, and of two
 * equal, the name first in the alphabet. Sorting all twenty thousand players
 * six times over to keep ten of each was most of what building these cost.
 */
class TopTen {
  readonly entries: SiteRecordEntry[] = []

  offer(name: string, value: number, at: number | null = null) {
    if (value <= 0) return
    const rows = this.entries
    if (rows.length === TOP_N && !above(value, name, rows[TOP_N - 1])) return
    let i = rows.length
    while (i > 0 && above(value, name, rows[i - 1])) i--
    rows.splice(i, 0, { name, value, at })
    if (rows.length > TOP_N) rows.pop()
  }
}

/*
 * Kept a minute for each audience: everyone, and each group that asks. A
 * save used to throw them away, so under steady play nearly every home page
 * visit read the whole score table again, a second and more at a few hundred
 * thousand scores. These are lifetime habits; a minute behind is fine.
 */
const CACHE_TTL_MS = 60_000
/** Audiences kept at once; the least recently built goes first. */
const CACHE_SCOPES = 32
const cache = new Map<string, { at: number; boards: SiteRecordBoard[] }>()
const building = new Map<string, Promise<SiteRecordBoard[]>>()
/** Counts wholesale changes (a ban's scores voided): a build begun before one isn't kept. */
let generation = 0

export function invalidateSiteRecords() {
  cache.clear()
  generation++
}

export async function siteRecords(
  scope?: { names: Set<string> } | null,
): Promise<SiteRecordBoard[]> {
  const key = scope ? [...scope.names].sort().join(',') : 'everyone'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.boards
  let pending = building.get(key)
  if (!pending) {
    const startedAt = generation
    pending = buildSiteRecords(scope)
      .then((boards) => {
        if (startedAt === generation) {
          cache.delete(key)
          cache.set(key, { at: Date.now(), boards })
          while (cache.size > CACHE_SCOPES) cache.delete(cache.keys().next().value as string)
        }
        return boards
      })
      .finally(() => building.delete(key))
    building.set(key, pending)
  }
  return pending
}

/**
 * Build every site record in one pass over the scores: the copy the boards
 * are drawn from (allScores), not another read of the table.
 */
async function buildSiteRecords(scope?: { names: Set<string> } | null): Promise<SiteRecordBoard[]> {
  const byGame = await allScores()

  const tallies = new Map<string, Tally>()
  /** Name → games whose all-time top score is theirs, for "boards held". */
  const held = new Map<string, number>()

  for (const [game, entries] of byGame) {
    // A game at a time, letting requests through in between: a few hundred
    // thousand rows in one go held everyone else up for most of a second.
    await new Promise((resolve) => setImmediate(resolve))
    // In board order, so the first row, the earlier of two equal scores, holds the board.
    let leader: string | null = null
    for (const { name, at } of entries) {
      if (scope && !scope.names.has(name)) continue
      if (leader == null) leader = name

      let tally = tallies.get(name)
      if (!tally) {
        tally = { games: 0, lastGame: '', byDay: new Map() }
        tallies.set(name, tally)
      }
      if (tally.lastGame !== game) {
        tally.lastGame = game
        tally.games++
      }
      const day = boardDateKey(at)
      let dayTally = tally.byDay.get(day)
      if (!dayTally) {
        dayTally = { runs: 0, games: 0, lastGame: '' }
        tally.byDay.set(day, dayTally)
      }
      dayTally.runs++
      if (dayTally.lastGame !== game) {
        dayTally.lastGame = game
        dayTally.games++
      }
    }
    if (leader != null) held.set(leader, (held.get(leader) ?? 0) + 1)
  }

  const streaks = new TopTen()
  const gamesInDay = new TopTen()
  const runsInDay = new TopTen()
  const daysPlayed = new TopTen()
  const gamesPlayed = new TopTen()
  const boardsHeld = new TopTen()
  /** Each day's day before, worked out once: there are only so many days. */
  const dayBefore = new Map<number, number>()

  for (const [name, tally] of tallies) {
    // Oldest day first, so of two equal days the first is the one kept.
    const days = [...tally.byDay].sort((a, b) => a[0] - b[0])
    let streak = 0
    let run = 0
    let prev: number | null = null
    let mostGames: DayTally | null = null
    let mostGamesAt: number | null = null
    let mostRuns: DayTally | null = null
    let mostRunsAt: number | null = null
    for (const [day, dayTally] of days) {
      let before = dayBefore.get(day)
      if (before === undefined) {
        before = previousBoardDateKey(day)
        dayBefore.set(day, before)
      }
      // The longest run of consecutive days present, ever: not the one ending today.
      run = prev != null && before === prev ? run + 1 : 1
      if (run > streak) streak = run
      prev = day
      if (!mostGames || dayTally.games > mostGames.games) {
        mostGames = dayTally
        mostGamesAt = day
      }
      if (!mostRuns || dayTally.runs > mostRuns.runs) {
        mostRuns = dayTally
        mostRunsAt = day
      }
    }

    streaks.offer(name, streak)
    gamesInDay.offer(name, mostGames?.games ?? 0, mostGamesAt)
    runsInDay.offer(name, mostRuns?.runs ?? 0, mostRunsAt)
    daysPlayed.offer(name, days.length)
    gamesPlayed.offer(name, tally.games)
    boardsHeld.offer(name, held.get(name) ?? 0)
  }

  return [
    { ...SITE_RECORD_DEFS['day-streak'], entries: streaks.entries },
    { ...SITE_RECORD_DEFS['games-in-a-day'], entries: gamesInDay.entries },
    { ...SITE_RECORD_DEFS['runs-in-a-day'], entries: runsInDay.entries },
    { ...SITE_RECORD_DEFS['days-played'], entries: daysPlayed.entries },
    { ...SITE_RECORD_DEFS['games-played'], entries: gamesPlayed.entries },
    { ...SITE_RECORD_DEFS['boards-topped'], entries: boardsHeld.entries },
  ]
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
