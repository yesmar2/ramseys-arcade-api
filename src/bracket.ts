import type { GameSlug } from './store.js'
import type { Tournament, TournamentPlayer, TournamentScore } from './tournaments.js'

export type TournamentKind = 'scores' | 'bracket'

export const BRACKET_SIZES = [4, 8, 16] as const
export type BracketSize = (typeof BRACKET_SIZES)[number]

export type BracketMatch = {
  id: string
  round: number
  slot: number
  playerIds: [string | null, string | null]
  winnerId: string | null
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

export type PublicBracketMatch = {
  id: string
  round: number
  slot: number
  winnerId: string | null
  players: [PublicBracketSide | null, PublicBracketSide | null]
}

export type PublicBracket = {
  lockedAt: number
  matches: PublicBracketMatch[]
}

export function isBracketSize(n: number): n is BracketSize {
  return (BRACKET_SIZES as readonly number[]).includes(n)
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

export function lockBracket(t: Tournament, now: number): boolean {
  if (t.bracket?.lockedAt) return false
  const n = t.players.length
  if (!isBracketSize(n)) return false
  const rng = mulberry32(hashSeed(t.id))
  const order = [...t.players]
  shuffleInPlace(order, rng)
  const rounds = Math.log2(n)
  const matches: BracketMatch[] = []
  for (let slot = 0; slot < n / 2; slot++) {
    matches.push({
      id: `m-1-${slot}`,
      round: 1,
      slot,
      playerIds: [order[slot * 2]!.id, order[slot * 2 + 1]!.id],
      winnerId: null,
    })
  }
  for (let round = 2; round <= rounds; round++) {
    const count = n / 2 ** round
    for (let slot = 0; slot < count; slot++) {
      matches.push({
        id: `m-${round}-${slot}`,
        round,
        slot,
        playerIds: [null, null],
        winnerId: null,
      })
    }
  }
  t.bracket = { lockedAt: now, matches }
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

export function matchAttempts(t: Tournament, playerId: string, matchId: string): number {
  return t.scores.filter((s) => s.playerId === playerId && s.matchId === matchId).length
}

function bestInMatch(
  t: Tournament,
  playerId: string,
  matchId: string,
): { score: number; at: number } | null {
  const rows = t.scores.filter((s) => s.playerId === playerId && s.matchId === matchId)
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

function pickWinner(t: Tournament, match: BracketMatch): string | null {
  const [a, b] = match.playerIds
  if (!a || !b) return null
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

function propagateWinner(t: Tournament, match: BracketMatch) {
  if (!match.winnerId || !t.bracket) return
  const next = t.bracket.matches.find(
    (m) => m.round === match.round + 1 && m.slot === Math.floor(match.slot / 2),
  )
  if (!next) return
  const side = match.slot % 2
  next.playerIds[side] = match.winnerId
}

export function resolveMatchIfReady(
  t: Tournament,
  match: BracketMatch,
  maxAttempts: number,
  force = false,
): boolean {
  if (match.winnerId || !match.playerIds[0] || !match.playerIds[1]) return false
  const usedA = matchAttempts(t, match.playerIds[0], match.id)
  const usedB = matchAttempts(t, match.playerIds[1], match.id)
  if (!force && (usedA < maxAttempts || usedB < maxAttempts)) return false
  const winner = pickWinner(t, match)
  if (!winner) return false
  match.winnerId = winner
  propagateWinner(t, match)
  return true
}

export function finalMatch(t: Tournament): BracketMatch | undefined {
  const matches = t.bracket?.matches
  if (!matches?.length) return undefined
  const maxRound = Math.max(...matches.map((m) => m.round))
  return matches.find((m) => m.round === maxRound)
}

export function bracketHasChampion(t: Tournament): boolean {
  return Boolean(finalMatch(t)?.winnerId)
}

export function resolveReadyMatches(t: Tournament, maxAttempts: number, force = false): boolean {
  if (!t.bracket) return false
  const ordered = [...t.bracket.matches].sort((a, b) => a.round - b.round || a.slot - b.slot)
  let changed = false
  for (const match of ordered) {
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

export function publicBracket(t: Tournament): PublicBracket | null {
  if (!t.bracket) return null
  const byId = new Map(t.players.map((p) => [p.id, p]))
  return {
    lockedAt: t.bracket.lockedAt,
    matches: t.bracket.matches.map((m) => ({
      id: m.id,
      round: m.round,
      slot: m.slot,
      winnerId: m.winnerId,
      players: m.playerIds.map((id) => {
        if (!id) return null
        const player = byId.get(id)
        const best = bestInMatch(t, id, m.id)
        return {
          id,
          name: player?.name ?? 'PLAYER',
          score: best?.score ?? null,
          attemptsUsed: matchAttempts(t, id, m.id),
        }
      }) as [PublicBracketSide | null, PublicBracketSide | null],
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
