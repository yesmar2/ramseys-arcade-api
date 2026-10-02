/*
 * The prize counter's catalogue: what can be traded for tickets, and for how
 * many. Every prize is a look, never a score: a badge finish, a style for the
 * tag on the boards, a card theme, confetti for a win, a title, and the signs
 * on the wall, which put the tag itself in lights. The site draws them (its
 * `src/data/prizes.ts`, kept in step with this list); the API owns the prices
 * and who owns what.
 *
 * A badge finish is worn as the avatar's badge, so its id is the badge's word
 * (avatars.ts). The rest are worn in the avatar string's last part.
 */

export type PrizeKind = 'finish' | 'name' | 'card' | 'confetti' | 'title' | 'sign'

/**
 * `earned`: never for sale; a Today streak (today.ts) or a season's pass (seasons.ts) gives it, and only
 * that. Its price is nought.
 */
export type Prize = { id: string; kind: PrizeKind; price: number; earned?: true }

export const PRIZES: readonly Prize[] = [
  { id: 'glitter', kind: 'finish', price: 450 },
  { id: 'starfield', kind: 'finish', price: 600 },
  { id: 'pixels', kind: 'finish', price: 700 },
  { id: 'neon', kind: 'finish', price: 900 },
  { id: 'lava', kind: 'finish', price: 1200 },
  { id: 'holo', kind: 'finish', price: 1500 },
  { id: 'aurora', kind: 'finish', price: 2000 },
  { id: 'nm-outline', kind: 'name', price: 150 },
  { id: 'nm-retro', kind: 'name', price: 250 },
  { id: 'nm-pixel', kind: 'name', price: 300 },
  { id: 'nm-glitch', kind: 'name', price: 350 },
  { id: 'nm-candy', kind: 'name', price: 400 },
  { id: 'nm-neon', kind: 'name', price: 500 },
  { id: 'nm-ember', kind: 'name', price: 600 },
  { id: 'cd-checker', kind: 'card', price: 600 },
  { id: 'cd-carpet', kind: 'card', price: 750 },
  { id: 'cd-sunset', kind: 'card', price: 1200 },
  { id: 'cd-asteroids', kind: 'card', price: 1800 },
  { id: 'cd-aquarium', kind: 'card', price: 2500 },
  { id: 'cd-fireflies', kind: 'card', price: 3500 },
  { id: 'cf-stars', kind: 'confetti', price: 150 },
  { id: 'cf-bubbles', kind: 'confetti', price: 150 },
  { id: 'cf-hearts', kind: 'confetti', price: 150 },
  { id: 'cf-pixels', kind: 'confetti', price: 200 },
  { id: 'cf-tickets', kind: 'confetti', price: 250 },
  { id: 'cf-fireworks', kind: 'confetti', price: 500 },
  { id: 't-insert', kind: 'title', price: 50 },
  { id: 't-start', kind: 'title', price: 50 },
  { id: 't-masher', kind: 'title', price: 60 },
  { id: 't-snack', kind: 'title', price: 60 },
  { id: 't-owl', kind: 'title', price: 80 },
  { id: 't-early', kind: 'title', price: 80 },
  { id: 't-onemore', kind: 'title', price: 80 },
  { id: 't-rage', kind: 'title', price: 100 },
  { id: 't-tutorial', kind: 'title', price: 100 },
  { id: 't-couch', kind: 'title', price: 120 },
  { id: 't-bugmagnet', kind: 'title', price: 120 },
  { id: 't-lurker', kind: 'title', price: 150 },
  { id: 't-rat', kind: 'title', price: 300 },
  { id: 't-jockey', kind: 'title', price: 350 },
  { id: 't-muncher', kind: 'title', price: 350 },
  { id: 't-hoarder', kind: 'title', price: 400 },
  { id: 't-cannon', kind: 'title', price: 450 },
  { id: 't-twist', kind: 'title', price: 500 },
  { id: 't-main', kind: 'title', price: 600 },
  { id: 't-bossmusic', kind: 'title', price: 700 },
  { id: 't-secret', kind: 'title', price: 900 },
  { id: 't-egg', kind: 'title', price: 1000 },
  { id: 't-extralife', kind: 'title', price: 1200 },
  { id: 't-finalboss', kind: 'title', price: 1500 },
  { id: 'sign-led', kind: 'sign', price: 4000 },
  { id: 'sign-marquee', kind: 'sign', price: 6500 },
  { id: 'sign', kind: 'sign', price: 10_000 },
  { id: 'sign-rooftop', kind: 'sign', price: 15_000 },
  // Earned by a Today streak (today.ts), never traded for.
  { id: 'gilded', kind: 'finish', price: 0, earned: true },
  { id: 't-everyday', kind: 'title', price: 0, earned: true },
  // Season 1, Space Race: its pass gives these at their levels (seasons.ts), never traded for.
  { id: 't-space-race', kind: 'title', price: 0, earned: true },
  { id: 't-liftoff', kind: 'title', price: 0, earned: true },
  { id: 't-space-cadet', kind: 'title', price: 0, earned: true },
  { id: 't-zero-g', kind: 'title', price: 0, earned: true },
  { id: 't-moonwalker', kind: 'title', price: 0, earned: true },
  { id: 'nm-starlight', kind: 'name', price: 0, earned: true },
  { id: 'nm-countdown', kind: 'name', price: 0, earned: true },
  { id: 'nm-nebula', kind: 'name', price: 0, earned: true },
  { id: 'orbit', kind: 'finish', price: 0, earned: true },
  { id: 'ringed', kind: 'finish', price: 0, earned: true },
  { id: 'mission', kind: 'finish', price: 0, earned: true },
  { id: 'supernova', kind: 'finish', price: 0, earned: true },
  { id: 'cd-deepfield', kind: 'card', price: 0, earned: true },
  { id: 'cd-launchpad', kind: 'card', price: 0, earned: true },
  { id: 'cd-nebula', kind: 'card', price: 0, earned: true },
  { id: 'cf-stardust', kind: 'confetti', price: 0, earned: true },
  { id: 'cf-shooting', kind: 'confetti', price: 0, earned: true },
  { id: 'sign-liftoff', kind: 'sign', price: 0, earned: true },
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
