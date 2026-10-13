import { allScores, boardDateKey, DAILY_GAMES, previousBoardDateKey, type GameSlug } from './store.js'
import { onRewrite } from './feed.js'

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
 *
 * "Busiest day", the most scores saved in a day whatever they were, went (Ramsey, 2026-10-13: "yes, all of
 * it"): a hundred runs thrown away a minute each beat a day of good ones. The streak is "Days played in a row",
 * as each game's is: the Dailies streak in the header is another thing, two of the day's races a day.
 */

export const SITE_RECORD_IDS = [
  'day-streak',
  'games-in-a-day',
  'days-played',
  'boards-topped',
] as const
export type SiteRecordId = (typeof SITE_RECORD_IDS)[number]

export type SiteRecordDef = {
  id: SiteRecordId
  label: string
  /** One line on what earns a place, in the same voice as the game books. */
  blurb: string
  unit: 'days' | 'games' | 'boards'
}

export const SITE_RECORD_DEFS: Record<SiteRecordId, SiteRecordDef> = {
  'day-streak': {
    id: 'day-streak',
    label: 'Days played in a row',
    blurb: 'Days in a row with a run on the board. Miss one and it starts again.',
    unit: 'days',
  },
  'games-in-a-day': {
    id: 'games-in-a-day',
    label: 'Most games in a day',
    blurb: 'Different cabinets played between one midnight and the next.',
    unit: 'games',
  },
  'days-played': {
    id: 'days-played',
    label: 'Most days played',
    blurb: 'Days with at least one run on them, all time. Turning up counts.',
    unit: 'days',
  },
  'boards-topped': {
    id: 'boards-topped',
    label: 'Boards held',
    blurb: 'Games whose all-time board has you at #1 right now.',
    unit: 'boards',
  },
}

export type SiteRecordEntry = {
  name: string
  value: number
  /** The day a peak happened, where the record is about one day. */
  at: number | null
}

export type SiteRecordBoard = SiteRecordDef & {
  entries: SiteRecordEntry[]
  /** How many share the most, which can be more than the top ten shows. */
  leaders: number
}

/**
 * Where one player stands on a site record: their number, their place (shared with everyone on as many: 1 +
 * how many have more), and how many others have as many. A place of null, with no number.
 */
export type SiteRecordStanding = { value: number; rank: number | null; tied?: number }

/**
 * Everything one player did, folded down as the rows go past.
 *
 * Built in a single pass because the alternative is five queries that have to
 * agree with each other about what a day is. The rows come a game at a time,
 * so a day's "which games" is a count and the game last counted, not a set.
 */
type Tally = {
  /** Day key → runs that day, and the games seen in it: every day played. */
  byDay: Map<number, DayTally>
}

type DayTally = {
  runs: number
  games: number
  lastGame: string
  /** The day's first run and its last: when the day was played, and when its runs reached their count. */
  first: number
  last: number
  /**
   * When the game counted last was first played that day, and the latest of the games' before it: so when
   * the day reached its count of games, the moment its last new game began.
   */
  gameFirst: number
  gamesBefore: number
}

const TOP_N = 10

/** Of two equal that got there at the same moment, the name first in the alphabet; one collator, as localeCompare would sort. */
const nameOrder = new Intl.Collator()

type Ranked = SiteRecordEntry & { reached: number }

/**
 * Whether a row goes above another: the most first, and of two equal, whoever got there first, as every
 * other record does (the dailies' records, a game's book); then the name first in the alphabet.
 */
function above(row: Ranked, than: Ranked) {
  if (row.value !== than.value) return row.value > than.value
  if (row.reached !== than.reached) return row.reached < than.reached
  return nameOrder.compare(row.name, than.name) < 0
}

/**
 * A board's top ten, kept as the players go past, in that order. Sorting all
 * twenty thousand players five times over to keep ten of each was most of
 * what building these cost.
 */
class TopTen {
  readonly rows: Ranked[] = []

  offer(name: string, value: number, reached: number, at: number | null = null) {
    if (value <= 0) return
    const row = { name, value, reached, at }
    const rows = this.rows
    if (rows.length === TOP_N && !above(row, rows[TOP_N - 1])) return
    let i = rows.length
    while (i > 0 && above(row, rows[i - 1])) i--
    rows.splice(i, 0, row)
    if (rows.length > TOP_N) rows.pop()
  }

  get entries(): SiteRecordEntry[] {
    return this.rows.map(({ name, value, at }) => ({ name, value, at }))
  }
}

/**
 * Every player's number on each board, for where one stands past the top ten: theirs by name, and each
 * board's numbers sorted, least first, to count who has more and who has as many.
 */
type Standings = { byName: Map<string, number[]>; sorted: Int32Array[] }

/** The first index in a sorted (least first) list whose number is above `value`. */
function after(sorted: Int32Array, value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** How many players have more than `value` on a board, and how many have just as many. */
function countAround(sorted: Int32Array, value: number): { more: number; same: number } {
  const end = after(sorted, value)
  return { more: sorted.length - end, same: end - after(sorted, value - 1) }
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
type Built = { boards: SiteRecordBoard[]; standings: Standings }
const cache = new Map<string, { at: number; built: Built }>()
const building = new Map<string, Promise<Built>>()
/** Counts wholesale changes (a ban's scores voided): a build begun before one isn't kept. */
let generation = 0

export function invalidateSiteRecords() {
  cache.clear()
  generation++
}

onRewrite('site-records', () => invalidateSiteRecords())

function siteRecordsBuilt(scope?: { names: Set<string> } | null): Promise<Built> {
  const key = scope ? [...scope.names].sort().join(',') : 'everyone'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.built)
  let pending = building.get(key)
  if (!pending) {
    const startedAt = generation
    pending = buildSiteRecords(scope)
      .then((built) => {
        if (startedAt === generation) {
          cache.delete(key)
          cache.set(key, { at: Date.now(), built })
          while (cache.size > CACHE_SCOPES) cache.delete(cache.keys().next().value as string)
        }
        return built
      })
      .finally(() => building.delete(key))
    building.set(key, pending)
  }
  return pending
}

export async function siteRecords(scope?: { names: Set<string> } | null): Promise<SiteRecordBoard[]> {
  return (await siteRecordsBuilt(scope)).boards
}

/**
 * Build every site record in one pass over the scores: the copy the boards
 * are drawn from (allScores), not another read of the table.
 */
async function buildSiteRecords(scope?: { names: Set<string> } | null): Promise<Built> {
  const byGame = await allScores()

  const tallies = new Map<string, Tally>()
  /**
   * Name → games whose all-time board has them at #1 (a daily has none), for "boards held", and when the
   * last of them was set: when they got to as many as they hold.
   */
  const held = new Map<string, { boards: number; at: number }>()

  for (const [game, entries] of byGame) {
    // A game at a time, letting requests through in between: a few hundred
    // thousand rows in one go held everyone else up for most of a second.
    await new Promise((resolve) => setImmediate(resolve))
    // In board order, so the first row, the earlier of two equal scores, holds the board.
    let leader: { name: string; at: number } | null = null
    for (const { name, at } of entries) {
      if (scope && !scope.names.has(name)) continue
      if (leader == null) leader = { name, at }

      let tally = tallies.get(name)
      if (!tally) {
        tally = { byDay: new Map() }
        tallies.set(name, tally)
      }
      const day = boardDateKey(at)
      let dayTally = tally.byDay.get(day)
      if (!dayTally) {
        dayTally = { runs: 0, games: 0, lastGame: '', first: at, last: at, gameFirst: at, gamesBefore: 0 }
        tally.byDay.set(day, dayTally)
      }
      dayTally.runs++
      if (at < dayTally.first) dayTally.first = at
      if (at > dayTally.last) dayTally.last = at
      if (dayTally.lastGame !== game) {
        // A game's rows all come together, so the one counted before is done with.
        if (dayTally.lastGame) dayTally.gamesBefore = Math.max(dayTally.gamesBefore, dayTally.gameFirst)
        dayTally.lastGame = game
        dayTally.gameFirst = at
        dayTally.games++
      } else if (at < dayTally.gameFirst) dayTally.gameFirst = at
    }
    // A daily has no all-time board to hold (store.ts ALL_TIME_GAMES): its best run is only one day's course's #1.
    if (DAILY_GAMES.has(game as GameSlug)) leader = null
    if (leader != null) {
      const had = held.get(leader.name)
      held.set(leader.name, { boards: (had?.boards ?? 0) + 1, at: Math.max(had?.at ?? 0, leader.at) })
    }
  }

  const streaks = new TopTen()
  const gamesInDay = new TopTen()
  const daysPlayed = new TopTen()
  const boardsHeld = new TopTen()
  /** Each player's four numbers, in SITE_RECORD_IDS' order. */
  const byName = new Map<string, number[]>()
  /** Each day's day before, worked out once: there are only so many days. */
  const dayBefore = new Map<number, number>()

  for (const [name, tally] of tallies) {
    // Oldest day first, so of two equal days the first is the one kept.
    const days = [...tally.byDay].sort((a, b) => a[0] - b[0])
    let streak = 0
    let streakReached = 0
    let run = 0
    let prev: number | null = null
    let mostGames: DayTally | null = null
    let mostGamesAt: number | null = null
    for (const [day, dayTally] of days) {
      let before = dayBefore.get(day)
      if (before === undefined) {
        before = previousBoardDateKey(day)
        dayBefore.set(day, before)
      }
      // The longest run of consecutive days present, ever: not the one ending today.
      run = prev != null && before === prev ? run + 1 : 1
      if (run > streak) {
        streak = run
        streakReached = dayTally.first
      }
      prev = day
      if (!mostGames || dayTally.games > mostGames.games) {
        mostGames = dayTally
        mostGamesAt = day
      }
    }
    const lastDay = days[days.length - 1]![1]
    const boards = held.get(name)
    const values = [streak, mostGames?.games ?? 0, days.length, boards?.boards ?? 0]
    byName.set(name, values)

    // Each at the moment it got there: the day its streak reached its length, its last new game of its day
    // of most games, its latest day's first run, the last of its boards taken.
    streaks.offer(name, values[0]!, streakReached)
    gamesInDay.offer(name, values[1]!, mostGames ? Math.max(mostGames.gamesBefore, mostGames.gameFirst) : 0, mostGamesAt)
    daysPlayed.offer(name, values[2]!, lastDay.first)
    boardsHeld.offer(name, values[3]!, boards?.at ?? 0)
  }

  const tops = [streaks, gamesInDay, daysPlayed, boardsHeld]
  const all = [...byName.values()]
  const sorted = SITE_RECORD_IDS.map((_, i) => Int32Array.from(all.map((v) => v[i]!).filter((v) => v > 0)).sort())
  return {
    boards: SITE_RECORD_IDS.map((id, i) => {
      const entries = tops[i]!.entries
      const most = entries[0]?.value
      return { ...SITE_RECORD_DEFS[id], entries, leaders: most ? countAround(sorted[i]!, most).same : 0 }
    }),
    standings: { byName, sorted },
  }
}

/** Where one player stands on each site record, past the top ten too. */
export async function siteRecordStandingFor(
  rawName: string,
  scope?: { names: Set<string> } | null,
): Promise<Record<SiteRecordId, SiteRecordStanding>> {
  const name = rawName.trim().slice(0, 12).toUpperCase()
  const { boards, standings } = await siteRecordsBuilt(scope)
  const values = standings.byName.get(name)
  const out = {} as Record<SiteRecordId, SiteRecordStanding>
  boards.forEach((board, i) => {
    const value = values?.[i] ?? 0
    if (value <= 0) {
      out[board.id] = { value: 0, rank: null }
      return
    }
    const { more, same } = countAround(standings.sorted[i]!, value)
    out[board.id] = { value, rank: more + 1, tied: same - 1 }
  })
  return out
}
