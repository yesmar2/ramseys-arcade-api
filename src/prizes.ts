/*
 * The prize counter's catalogue: what can be traded for tickets, and for how
 * many. Every prize is a look, never a score: a badge finish, a style for the
 * tag on the boards, a card theme, confetti for a win, a title, and the neon
 * sign at the top of the wall. The site draws them (its `src/data/prizes.ts`,
 * kept in step with this list); the API owns the prices and who owns what.
 *
 * A badge finish is worn as the avatar's badge, so its id is the badge's word
 * (avatars.ts). The rest are worn in the avatar string's last part.
 */

export type PrizeKind = 'finish' | 'name' | 'card' | 'confetti' | 'title' | 'sign'

export type Prize = { id: string; kind: PrizeKind; price: number }

export const PRIZES: readonly Prize[] = [
  { id: 'glitter', kind: 'finish', price: 450 },
  { id: 'starfield', kind: 'finish', price: 600 },
  { id: 'neon', kind: 'finish', price: 900 },
  { id: 'holo', kind: 'finish', price: 1500 },
  { id: 'nm-outline', kind: 'name', price: 150 },
  { id: 'nm-pixel', kind: 'name', price: 300 },
  { id: 'nm-candy', kind: 'name', price: 400 },
  { id: 'nm-neon', kind: 'name', price: 500 },
  { id: 'cd-carpet', kind: 'card', price: 750 },
  { id: 'cd-aquarium', kind: 'card', price: 2500 },
  { id: 'cf-stars', kind: 'confetti', price: 150 },
  { id: 'cf-bubbles', kind: 'confetti', price: 150 },
  { id: 'cf-tickets', kind: 'confetti', price: 250 },
  { id: 't-masher', kind: 'title', price: 60 },
  { id: 't-snack', kind: 'title', price: 60 },
  { id: 't-owl', kind: 'title', price: 80 },
  { id: 't-early', kind: 'title', price: 80 },
  { id: 't-onemore', kind: 'title', price: 80 },
  { id: 't-couch', kind: 'title', price: 120 },
  { id: 'sign', kind: 'sign', price: 10_000 },
]

const byId = new Map(PRIZES.map((p) => [p.id, p]))

export function prizeById(id: string): Prize | null {
  return byId.get(id) ?? null
}

/** The badge finishes, as the words the avatar's badge takes. */
export const FINISH_BADGES = PRIZES.filter((p) => p.kind === 'finish').map((p) => p.id)

export function isFinishBadge(badge: string): boolean {
  return FINISH_BADGES.includes(badge)
}

/** A prize worn in the avatar string's last part: anything but a finish, which is the badge. */
export function isWornPrize(id: string): boolean {
  const prize = byId.get(id)
  return !!prize && prize.kind !== 'finish'
}
