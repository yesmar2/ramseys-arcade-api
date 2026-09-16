import type { GameSlug } from './store.js'
import type { Tournament, TournamentPlayer, TournamentScore } from './tournaments.js'

export type TournamentKind = 'scores' | 'bracket'

export const BRACKET_PLAYERS_MIN = 2
export const BRACKET_PLAYERS_MAX = 64

export function isBracketSize(n: number): boolean {
  return Number.isInteger(n) && n >= BRACKET_PLAYERS_MIN && n <= BRACKET_PLAYERS_MAX
}

/** Next power of two that can hold this roster (2…64). */
export function bracketDrawSize(n: number): number {
  const capped = Math.max(BRACKET_PLAYERS_MIN, Math.min(BRACKET_PLAYERS_MAX, Math.floor(n)))
  return 2 ** Math.ceil(Math.log2(capped))
}

export type Elimination = 'single' | 'double'

/** Which half of a double-elim draw a match belongs to. Absent = winners. */
export type BracketSide = 'wb' | 'lb' | 'gf'

/** Where a result lands. Double-elim routing can't be derived from round+slot. */
export type MatchFeed = { matchId: string; side: 0 | 1 }

export type BracketMatch = {
  id: string
  round: number
  slot: number
  playerIds: [string | null, string | null]
  winnerId: string | null
  /** When both sides are seated: deadline to finish attempts before auto-resolve. */
  playEndsAt?: number | null
  /** Undefined on single-elim (and pre-existing) matches — treated as 'wb'. */
  bracket?: BracketSide
  /** Set only on double-elim matches; single-elim uses round arithmetic. */
  winnerTo?: MatchFeed | null
  loserTo?: MatchFeed | null
  /** A grand-final reset that is no longer needed, or a slot nothing can fill. */
  void?: boolean
}

export type TournamentBracket = {
  lockedAt: number
  matches: BracketMatch[]
}

export type PublicBracketSide = {
  id: string
  name: string
  score: number | null
  attemptsUsed: number
}

/** Where an empty seat's occupant comes from, e.g. the loser of winners R2. */
export type SlotFeed = {
  from: 'winner' | 'loser'
  bracket: BracketSide
  round: number
}

export type PublicBracketMatch = {
  id: string
  round: number
  slot: number
  bracket: BracketSide
  winnerId: string | null
  playEndsAt: number | null
  players: [PublicBracketSide | null, PublicBracketSide | null]
  /** Per-seat source, so an unfilled seat can name what it is waiting on. */
  from: [SlotFeed | null, SlotFeed | null]
}

/**
 * Invert the draw's winnerTo/loserTo routing into "who feeds this seat".
 * Single-elim matches carry no feeds, so their seats simply stay unlabelled.
 */
function slotFeeds(matches: BracketMatch[]): Map<string, [SlotFeed | null, SlotFeed | null]> {
  const feeds = new Map<string, [SlotFeed | null, SlotFeed | null]>()
  const seatsOf = (id: string) => {
    const existing = feeds.get(id)
    if (existing) return existing
    const row: [SlotFeed | null, SlotFeed | null] = [null, null]
    feeds.set(id, row)
    return row
  }
  for (const m of matches) {
    const source = (from: 'winner' | 'loser'): SlotFeed => ({
      from,
      bracket: matchSide(m),
      round: m.round,
    })
    if (m.winnerTo) seatsOf(m.winnerTo.matchId)[m.winnerTo.side] = source('winner')
    if (m.loserTo) seatsOf(m.loserTo.matchId)[m.loserTo.side] = source('loser')
  }
  return feeds
}

const NO_FEEDS: [SlotFeed | null, SlotFeed | null] = [null, null]

export type PublicBracket = {
  lockedAt: number
  elimination: Elimination
  matches: PublicBracketMatch[]
}

export function resolveElimination(t: Pick<Tournament, 'rules'>): Elimination {
  return t.rules?.elimination === 'double' ? 'double' : 'single'
}

export function matchSide(m: Pick<BracketMatch, 'bracket'>): BracketSide {
  return m.bracket ?? 'wb'
}

/** Double elim needs a full draw — byes in a losers bracket get ugly fast. */
export function isDoubleElimSize(n: number): boolean {
  return isBracketSize(n) && Number.isInteger(Math.log2(n))
}

export function resolveKind(t: Pick<Tournament, 'kind'>): TournamentKind {
  return t.kind === 'bracket' ? 'bracket' : 'scores'
}

export function hashSeed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
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

function shuffleInPlace<T>(items: T[], rng: () => number) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j]!, items[i]!]
  }
}

/** Standard single-elim seed order: 1vN, then 2 vs N-1 on the opposite half, and so on. */
export function seededBracketOrder(size: number): number[] {
  let seeds = [1]
  while (seeds.length < size) {
    const n = seeds.length * 2
    const next: number[] = []
    for (const seed of seeds) {
      next.push(seed)
      next.push(n + 1 - seed)
    }
    seeds = next
  }
  return seeds
}

function applyByes(t: Tournament) {
  if (!t.bracket) return
  for (const match of t.bracket.matches) {
    // Only first-round vacancies are byes. Later empty slots are waiting on a feeder.
    if (match.round !== 1 || match.winnerId) continue
    const [a, b] = match.playerIds
    if (a && !b) {
      match.winnerId = a
      propagateWinner(t, match)
    } else if (b && !a) {
      match.winnerId = b
      propagateWinner(t, match)
    }
  }
}

function roundPlayMs(t: Tournament): number {
  const hours = t.rules?.roundPlayHours
  if (hours == null || !(hours > 0)) return 0
  return Math.floor(hours) * 3_600_000
}

/** Start the play clock on any fully seated open match that does not have one yet. */
export function armMatchClocks(t: Tournament, now: number): boolean {
  if (!t.bracket) return false
  const windowMs = roundPlayMs(t)
  if (windowMs <= 0) return false
  let changed = false
  for (const match of t.bracket.matches) {
    if (match.winnerId) continue
    if (!match.playerIds[0] || !match.playerIds[1]) continue
    if (match.playEndsAt != null) continue
    match.playEndsAt = now + windowMs
    changed = true
  }
  return changed
}

const wbId = (round: number, slot: number) => `wb-${round}-${slot}`
const lbId = (round: number, slot: number) => `lb-${round}-${slot}`
const GF_ID = 'gf-1-0'
const GF_RESET_ID = 'gf-2-0'

/** Losers-bracket match count for round `l` of a 2^n draw. */
function lbRoundSize(n: number, l: number): number {
  return 2 ** (n - 1 - Math.ceil(l / 2))
}

/**
 * Build a full double-elimination draw.
 *
 * Winners rounds 1..n feed forward as usual; their losers drop into the
 * losers bracket, which alternates "minor" rounds (LB survivors pair off) with
 * "major" rounds (LB survivors meet the freshly-dropped WB losers). The LB
 * champion meets the WB champion in the grand final, and because the WB
 * champion has not lost yet, an LB win there forces a reset match.
 */
function buildDoubleElim(field: TournamentPlayer[], size: number): BracketMatch[] {
  const n = Math.log2(size)
  const lbRounds = Math.max(0, 2 * n - 2)
  const matches: BracketMatch[] = []
  const seeds = seededBracketOrder(size)
  const count = field.length

  const make = (
    id: string,
    bracket: BracketSide,
    round: number,
    slot: number,
    playerIds: [string | null, string | null] = [null, null],
  ): BracketMatch => ({
    id,
    round,
    slot,
    bracket,
    playerIds,
    winnerId: null,
    playEndsAt: null,
    winnerTo: null,
    loserTo: null,
  })

  // --- winners bracket ---
  for (let round = 1; round <= n; round++) {
    for (let slot = 0; slot < 2 ** (n - round); slot++) {
      const m = make(wbId(round, slot), 'wb', round, slot)
      if (round === 1) {
        const seedA = seeds[slot * 2]!
        const seedB = seeds[slot * 2 + 1]!
        m.playerIds = [
          seedA <= count ? field[seedA - 1]!.id : null,
          seedB <= count ? field[seedB - 1]!.id : null,
        ]
      }
      m.winnerTo =
        round === n
          ? { matchId: GF_ID, side: 0 }
          : { matchId: wbId(round + 1, Math.floor(slot / 2)), side: (slot % 2) as 0 | 1 }

      if (lbRounds === 0) {
        // Two-player draw: the only loser goes straight to the grand final.
        m.loserTo = { matchId: GF_ID, side: 1 }
      } else if (round === 1) {
        m.loserTo = { matchId: lbId(1, Math.floor(slot / 2)), side: (slot % 2) as 0 | 1 }
      } else {
        m.loserTo = { matchId: lbId(2 * (round - 1), slot), side: 1 }
      }
      matches.push(m)
    }
  }

  // --- losers bracket ---
  for (let l = 1; l <= lbRounds; l++) {
    for (let slot = 0; slot < lbRoundSize(n, l); slot++) {
      const m = make(lbId(l, slot), 'lb', l, slot)
      if (l === lbRounds) {
        m.winnerTo = { matchId: GF_ID, side: 1 }
      } else if (l % 2 === 1) {
        // Minor round: survivors line up 1:1 against the next wave of WB losers.
        m.winnerTo = { matchId: lbId(l + 1, slot), side: 0 }
      } else {
        // Major round: survivors pair off.
        m.winnerTo = { matchId: lbId(l + 1, Math.floor(slot / 2)), side: (slot % 2) as 0 | 1 }
      }
      matches.push(m)
    }
  }

  // --- grand final (+ reset) ---
  const gf = make(GF_ID, 'gf', 1, 0)
  // Only used when the LB champion wins game one; the WB champion keeps side 0.
  gf.winnerTo = { matchId: GF_RESET_ID, side: 1 }
  gf.loserTo = { matchId: GF_RESET_ID, side: 0 }
  matches.push(gf)
  matches.push(make(GF_RESET_ID, 'gf', 2, 0))

  return matches
}

export function lockBracket(t: Tournament, now: number): boolean {
  if (t.bracket?.lockedAt) return false
  const n = t.players.length
  if (!isBracketSize(n)) return false
  const rng = mulberry32(hashSeed(t.id))
  const field = [...t.players]
  shuffleInPlace(field, rng)
  const size = bracketDrawSize(n)

  if (resolveElimination(t) === 'double') {
    t.bracket = { lockedAt: now, matches: buildDoubleElim(field, size) }
    t.startsAt = now
    // Same first-round walkovers the single-elim path applies. A double draw
    // normally locks on a full power-of-two field and has none, but without
    // this an under-full field leaves half-seated matches that nothing can
    // ever resolve: the clock only arms on two seated players, and so does
    // the winner check. The bracket would hang forever.
    applyByes(t)
    settleUnfillableSlots(t)
    armMatchClocks(t, now)
    return true
  }

  const firstRound = size / 2
  const seeds = seededBracketOrder(size)
  const matches: BracketMatch[] = []
  for (let slot = 0; slot < firstRound; slot++) {
    const seedA = seeds[slot * 2]!
    const seedB = seeds[slot * 2 + 1]!
    const a = seedA <= n ? field[seedA - 1]!.id : null
    const b = seedB <= n ? field[seedB - 1]!.id : null
    matches.push({
      id: `m-1-${slot}`,
      round: 1,
      slot,
      playerIds: [a, b],
      winnerId: null,
      playEndsAt: null,
    })
  }
  const rounds = Math.log2(size)
  for (let round = 2; round <= rounds; round++) {
    const count = size / 2 ** round
    for (let slot = 0; slot < count; slot++) {
      matches.push({
        id: `m-${round}-${slot}`,
        round,
        slot,
        playerIds: [null, null],
        winnerId: null,
        playEndsAt: null,
      })
    }
  }
  t.bracket = { lockedAt: now, matches }
  // Bracket events have no overall clock — only per-match round timers.
  t.startsAt = now
  applyByes(t)
  armMatchClocks(t, now)
  return true
}

export function maybeLockBracket(t: Tournament, now: number): boolean {
  if (resolveKind(t) !== 'bracket' || t.bracket?.lockedAt) return false
  const cap = t.rules?.maxPlayers ?? 0
  if (!isBracketSize(cap) || t.players.length < cap) return false
  return lockBracket(t, now)
}

export function findOpenMatch(t: Tournament, playerId: string): BracketMatch | null {
  const matches = t.bracket?.matches
  if (!matches) return null
  return (
    matches.find(
      (m) =>
        !m.winnerId &&
        m.playerIds[0] &&
        m.playerIds[1] &&
        (m.playerIds[0] === playerId || m.playerIds[1] === playerId),
    ) ?? null
  )
}


/**
 * Games a round is played on.
 *
 * Stored as a list per round; a bare slug is read as a round of one, so plans
 * written before rounds could hold several still load. Losers rounds reuse the
 * winners round of the same number and the grand final the last, so anything
 * past the end clamps rather than wrapping back to round one.
 */
export function bracketGamesForRound(
  t: Pick<Tournament, 'games' | 'rules'>,
  round: number,
): string[] {
  const raw = (t.rules as { roundGames?: unknown } | undefined)?.roundGames
  const plan: string[][] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const list = (Array.isArray(entry) ? entry : [entry]).filter(
        (g): g is string => typeof g === 'string' && g.length > 0,
      )
      if (list.length) plan.push(list)
    }
  }
  if (!plan.length) return t.games.slice(0, 1)
  const index = Math.min(Math.max(1, round), plan.length) - 1
  return plan[index] ?? t.games.slice(0, 1)
}

export function matchAttempts(
  t: Tournament,
  playerId: string,
  matchId: string,
  game?: string,
): number {
  return t.scores.filter(
    (s) =>
      s.playerId === playerId && s.matchId === matchId && (!game || s.game === game),
  ).length
}

export function bestInMatch(
  t: Tournament,
  playerId: string,
  matchId: string,
  game?: string,
): { score: number; at: number } | null {
  const rows = t.scores.filter(
    (s) =>
      s.playerId === playerId && s.matchId === matchId && (!game || s.game === game),
  )
  if (rows.length === 0) return null
  let best = rows[0]!
  for (const row of rows) {
    if (row.score > best.score || (row.score === best.score && row.at < best.at)) {
      best = row
    }
  }
  return { score: best.score, at: best.at }
}

function joinRank(t: Tournament, playerId: string): number {
  const idx = t.players.findIndex((p) => p.id === playerId)
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER
}

/** Head-to-head on one game: the better score, then the earlier one. */
function wonGame(t: Tournament, match: BracketMatch, a: string, b: string, game: string) {
  const bestA = bestInMatch(t, a, match.id, game)
  const bestB = bestInMatch(t, b, match.id, game)
  const scoreA = bestA?.score ?? 0
  const scoreB = bestB?.score ?? 0
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b
  if (bestA && bestB && bestA.at !== bestB.at) return bestA.at < bestB.at ? a : b
  if (bestA && !bestB) return a
  if (bestB && !bestA) return b
  return null
}

function pickWinner(t: Tournament, match: BracketMatch): string | null {
  const [a, b] = match.playerIds
  if (!a || !b) return null

  /*
   * A round on several games is a series, won by taking the most of them —
   * never by adding the scores up. Scores are not comparable across games:
   * a Crumbtrail run is in the tens of thousands and a Snake run in the
   * hundreds, so a total would just hand the match to whoever played the
   * bigger-numbered game. An even split falls through to the tiebreak below.
   */
  const games = bracketGamesForRound(t, match.round)
  if (games.length > 1) {
    let winsA = 0
    let winsB = 0
    for (const game of games) {
      const won = wonGame(t, match, a, b, game)
      if (won === a) winsA += 1
      else if (won === b) winsB += 1
    }
    if (winsA !== winsB) return winsA > winsB ? a : b
  }

  const bestA = bestInMatch(t, a, match.id)
  const bestB = bestInMatch(t, b, match.id)
  const scoreA = bestA?.score ?? 0
  const scoreB = bestB?.score ?? 0
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b
  if (bestA && bestB && bestA.at !== bestB.at) return bestA.at < bestB.at ? a : b
  if (bestA && !bestB) return a
  if (bestB && !bestA) return b
  return joinRank(t, a) <= joinRank(t, b) ? a : b
}

function seat(t: Tournament, feed: MatchFeed | null | undefined, playerId: string | null) {
  if (!feed || !playerId || !t.bracket) return
  const target = t.bracket.matches.find((m) => m.id === feed.matchId)
  if (!target || target.void) return
  target.playerIds[feed.side] = playerId
}

/**
 * Move a decided match's players onward.
 *
 * Single-elim matches (including brackets locked before double-elim existed)
 * carry no feed links and keep using round arithmetic.
 */
function propagateWinner(t: Tournament, match: BracketMatch) {
  if (!match.winnerId || !t.bracket) return

  if (!match.winnerTo && !match.loserTo) {
    const next = t.bracket.matches.find(
      (m) => m.round === match.round + 1 && m.slot === Math.floor(match.slot / 2),
    )
    if (!next) return
    next.playerIds[match.slot % 2] = match.winnerId
    return
  }

  const [a, b] = match.playerIds
  const loserId = match.winnerId === a ? b : a

  if (matchSide(match) === 'gf' && match.round === 1) {
    // The WB champion arrives unbeaten: losing game one only levels the series.
    const wbChampWon = match.winnerId === a
    const reset = t.bracket.matches.find((m) => m.id === GF_RESET_ID)
    if (wbChampWon) {
      if (reset) reset.void = true
      return
    }
    seat(t, match.winnerTo, match.winnerId)
    seat(t, match.loserTo, loserId)
    return
  }

  seat(t, match.winnerTo, match.winnerId)
  seat(t, match.loserTo, loserId)
}

/**
 * Advance anyone left waiting on a seat that can never be filled.
 *
 * Only reachable if a double-elim draw locks without a full roster (creation
 * enforces a power-of-two field, so this is a safety net): a winners-bracket
 * bye produces no loser, which would otherwise strand its losers-bracket match.
 */
function settleUnfillableSlots(t: Tournament): boolean {
  if (!t.bracket) return false
  const byId = new Map(t.bracket.matches.map((m) => [m.id, m]))
  let changed = false

  for (let pass = 0; pass < t.bracket.matches.length + 2; pass++) {
    // A slot is dead when its feeder is decided (or void) and sends nobody.
    const dead = new Set<string>()
    for (const m of t.bracket.matches) {
      const occupants = m.playerIds.filter(Boolean).length
      const settled = Boolean(m.winnerId) || m.void
      if (!settled) continue
      if (m.loserTo && (m.void || occupants < 2)) dead.add(`${m.loserTo.matchId}:${m.loserTo.side}`)
      if (m.winnerTo && m.void) dead.add(`${m.winnerTo.matchId}:${m.winnerTo.side}`)
    }

    let moved = false
    for (const m of t.bracket.matches) {
      if (m.winnerId || m.void) continue
      const [a, b] = m.playerIds
      const aDead = !a && dead.has(`${m.id}:0`)
      const bDead = !b && dead.has(`${m.id}:1`)
      if (a && bDead) {
        m.winnerId = a
        propagateWinner(t, m)
        moved = true
      } else if (b && aDead) {
        m.winnerId = b
        propagateWinner(t, m)
        moved = true
      } else if (aDead && bDead) {
        m.void = true
        if (m.winnerTo) {
          const next = byId.get(m.winnerTo.matchId)
          if (next) moved = true
        }
        moved = true
      }
    }
    if (!moved) break
    changed = true
  }
  return changed
}

export function resolveTimedOutMatches(t: Tournament, maxAttempts: number, now: number): boolean {
  if (!t.bracket) return false
  const ordered = [...t.bracket.matches].sort((a, b) => a.round - b.round || a.slot - b.slot)
  let changed = false
  for (const match of ordered) {
    if (match.winnerId || !match.playEndsAt || now <= match.playEndsAt) continue
    if (resolveMatchIfReady(t, match, maxAttempts, true)) changed = true
  }
  return changed
}

/** Soonest deadline among open, seated matches — for UI countdown. */
export function earliestOpenMatchDeadline(t: Tournament): number | null {
  if (!t.bracket) return null
  let min: number | null = null
  for (const match of t.bracket.matches) {
    if (match.winnerId || !match.playerIds[0] || !match.playerIds[1]) continue
    if (match.playEndsAt == null) continue
    if (min == null || match.playEndsAt < min) min = match.playEndsAt
  }
  return min
}

export type OpenMatchPair = { a: string; b: string }

/**
 * The match-ups currently being played, for the event card.
 *
 * Only once the draw has locked — before that nobody has an opponent yet, and
 * the whole point of hiding the preview is that nobody sees who they drew
 * until the last seat fills. Ordered the way the bracket cascades, so the
 * first few are the ones furthest along.
 */
export function openMatchPairs(t: Tournament, limit = 3): OpenMatchPair[] {
  if (!t.bracket?.lockedAt) return []
  const out: OpenMatchPair[] = []
  const ordered = [...t.bracket.matches].sort(
    (x, y) =>
      SIDE_ORDER[matchSide(x)] - SIDE_ORDER[matchSide(y)] ||
      x.round - y.round ||
      x.slot - y.slot,
  )
  for (const match of ordered) {
    if (out.length >= limit) break
    const [a, b] = match.playerIds
    if (match.winnerId || !a || !b) continue
    out.push({ a: playerNameFor(t, a), b: playerNameFor(t, b) })
  }
  return out
}

export function resolveMatchIfReady(
  t: Tournament,
  match: BracketMatch,
  maxAttempts: number,
  force = false,
): boolean {
  if (match.winnerId || !match.playerIds[0] || !match.playerIds[1]) return false
  const a = match.playerIds[0]
  const b = match.playerIds[1]
  /*
   * Attempts are per game, so a round on three games is done when a player has
   * spent their tries on all three — not when they have burned them all on one.
   */
  const games = bracketGamesForRound(t, match.round)
  const finite = Number.isFinite(maxAttempts)
  const spentAll = (player: string) =>
    finite && games.every((game) => matchAttempts(t, player, match.id, game) >= maxAttempts)
  const doneA = spentAll(a)
  const doneB = spentAll(b)
  if (!force && !doneA && !doneB) return false
  if (!force && (!doneA || !doneB)) {
    /*
     * The early call: one player is finished and the other cannot catch them.
     * Only safe on a single game, where "ahead" is one comparison. Across a
     * series the remaining games can still swing it, so the match waits.
     */
    if (games.length > 1) return false
    const scoreA = bestInMatch(t, a, match.id)?.score ?? 0
    const scoreB = bestInMatch(t, b, match.id)?.score ?? 0
    const aheadPastCatchup =
      (doneB && scoreA > scoreB) || (doneA && scoreB > scoreA)
    if (!aheadPastCatchup) return false
  }
  const winner = pickWinner(t, match)
  if (!winner) return false
  match.winnerId = winner
  propagateWinner(t, match)
  settleUnfillableSlots(t)
  return true
}

/** Cascade order: winners, then losers, then the grand final. */
const SIDE_ORDER: Record<BracketSide, number> = { wb: 0, lb: 1, gf: 2 }

function orderedMatches(t: Tournament): BracketMatch[] {
  return [...(t.bracket?.matches ?? [])].sort(
    (a, b) =>
      SIDE_ORDER[matchSide(a)] - SIDE_ORDER[matchSide(b)] ||
      a.round - b.round ||
      a.slot - b.slot,
  )
}

export function finalMatch(t: Tournament): BracketMatch | undefined {
  const matches = t.bracket?.matches
  if (!matches?.length) return undefined

  if (resolveElimination(t) === 'double') {
    const reset = matches.find((m) => m.id === GF_RESET_ID)
    // The reset only counts once it is actually in play.
    if (reset && !reset.void && reset.playerIds[0] && reset.playerIds[1]) return reset
    return matches.find((m) => m.id === GF_ID)
  }

  const maxRound = Math.max(...matches.map((m) => m.round))
  return matches.find((m) => m.round === maxRound)
}

export function bracketHasChampion(t: Tournament): boolean {
  if (resolveElimination(t) !== 'double') {
    return Boolean(finalMatch(t)?.winnerId)
  }
  const matches = t.bracket?.matches
  if (!matches?.length) return false
  const gf = matches.find((m) => m.id === GF_ID)
  if (!gf?.winnerId) return false
  // WB champion winning game one ends it; otherwise the reset decides.
  if (gf.winnerId === gf.playerIds[0]) return true
  const reset = matches.find((m) => m.id === GF_RESET_ID)
  return Boolean(reset?.winnerId)
}

export function resolveReadyMatches(t: Tournament, maxAttempts: number, force = false): boolean {
  let changed = false
  for (const match of orderedMatches(t)) {
    if (resolveMatchIfReady(t, match, maxAttempts, force)) changed = true
  }
  return changed
}

export function maybeEndWhenBracketFinished(t: Tournament, now: number): boolean {
  if (!bracketHasChampion(t)) return false
  if (t.endsAt > now) t.endsAt = now
  if (t.rules?.unlimitedDuration) t.rules.unlimitedDuration = false
  return true
}

/**
 * Cosmetic bracket shape for a bracket-kind event that hasn't locked yet —
 * shows the full round structure with players seated in join order (not the
 * real seeded draw) so the shape is visible while the roster fills. Replaced
 * outright by the real, shuffled bracket once `lockBracket` runs.
 */
export function previewBracket(t: Tournament): PublicBracket | null {
  if (resolveKind(t) !== 'bracket' || t.bracket?.lockedAt) return null
  const cap = t.rules?.maxPlayers ?? 0
  const size = isBracketSize(cap)
    ? bracketDrawSize(cap)
    : bracketDrawSize(Math.max(BRACKET_PLAYERS_MIN, t.players.length))
  const elimination = resolveElimination(t)

  /*
   * The preview is the shape only — how many rounds, how the halves feed the
   * final — and never who is in which seat.
   *
   * It used to seat everyone in join order, which was wrong twice over: the
   * real draw is a seeded shuffle, so those pairings were not the ones anybody
   * would actually play, and showing them gave away the one moment a bracket
   * has before it starts. Nobody sees who they drew until the last seat fills.
   */
  if (elimination === 'double') {
    const built = buildDoubleElim(t.players, size)
    // Feeds point at unprefixed ids, so resolve them before renaming for preview.
    const feeds = slotFeeds(built)
    const matches = built.map<PublicBracketMatch>((m) => ({
      id: `preview-${m.id}`,
      round: m.round,
      slot: m.slot,
      bracket: matchSide(m),
      winnerId: null,
      playEndsAt: null,
      players: [null, null],
      from: feeds.get(m.id) ?? NO_FEEDS,
    }))
    return { lockedAt: 0, elimination, matches }
  }

  const firstRound = size / 2
  const rounds = Math.log2(size)
  const matches: PublicBracketMatch[] = []
  for (let slot = 0; slot < firstRound; slot++) {
    matches.push({
      id: `preview-1-${slot}`,
      round: 1,
      slot,
      bracket: 'wb',
      winnerId: null,
      playEndsAt: null,
      players: [null, null],
      from: NO_FEEDS,
    })
  }
  for (let round = 2; round <= rounds; round++) {
    const count = size / 2 ** round
    for (let slot = 0; slot < count; slot++) {
      matches.push({
        id: `preview-${round}-${slot}`,
        round,
        slot,
        bracket: 'wb',
        winnerId: null,
        playEndsAt: null,
        players: [null, null],
        from: NO_FEEDS,
      })
    }
  }
  return { lockedAt: 0, elimination, matches }
}

export function publicBracket(t: Tournament): PublicBracket | null {
  if (!t.bracket) return null
  const byId = new Map(t.players.map((p) => [p.id, p]))
  const feeds = slotFeeds(t.bracket.matches)
  return {
    lockedAt: t.bracket.lockedAt,
    elimination: resolveElimination(t),
    // A voided grand-final reset never happened — don't show an empty card.
    matches: t.bracket.matches
      .filter((m) => !m.void)
      .map((m) => ({
      id: m.id,
      round: m.round,
      slot: m.slot,
      bracket: matchSide(m),
      winnerId: m.winnerId,
      playEndsAt: m.playEndsAt ?? null,
      players: m.playerIds.map((id) => {
        if (!id) {
          const filled = m.playerIds.filter(Boolean).length
          if (m.round === 1 && matchSide(m) !== 'gf' && filled === 1 && m.winnerId) {
            return { id: '', name: 'BYE', score: null, attemptsUsed: 0 }
          }
          return null
        }
        const player = byId.get(id)
        const best = bestInMatch(t, id, m.id)
        return {
          id,
          name: player?.name ?? 'PLAYER',
          score: best?.score ?? null,
          attemptsUsed: matchAttempts(t, id, m.id),
        }
      }) as [PublicBracketSide | null, PublicBracketSide | null],
      from: feeds.get(m.id) ?? NO_FEEDS,
      })),
  }
}

export function playerNameFor(t: Tournament, playerId: string): string {
  return t.players.find((p) => p.id === playerId)?.name ?? 'PLAYER'
}

export function opponentId(match: BracketMatch, playerId: string): string | null {
  if (match.playerIds[0] === playerId) return match.playerIds[1]
  if (match.playerIds[1] === playerId) return match.playerIds[0]
  return null
}

export type { TournamentPlayer, TournamentScore, GameSlug }
