/*
 * The prize counter's catalogue: what can be traded for tickets, and for how
 * many. Every prize is a look, never a score: an avatar (a finish for the
 * avatar's badge), a style for the tag on the boards, a background for the
 * player card, confetti for a win, and the Hangar's skins. Titles are earned,
 * never traded for, and the signs are retired. A card foil, a sheen over the
 * player card, comes only from a season's pass. The site draws them (its
 * `src/data/prizes.ts`, kept in step with this list); the API owns the prices
 * and who owns what.
 *
 * A badge finish is worn as the avatar's badge, so its id is the badge's word
 * (avatars.ts). The rest are worn in the avatar string's last part.
 */

export type PrizeKind = 'finish' | 'name' | 'card' | 'confetti' | 'title' | 'sign' | 'skin' | 'foil'

/**
 * `earned`: never for sale; a Today streak (today.ts), a season's pass (seasons.ts) or a month of Plus
 * (plus.ts) gives it, and only that. Its price is nought.
 *
 * `retired`: off the counter for good, never traded for or saved for again, but still worn by anyone who
 * has it. The titles that were for tickets are retired: a title is earned now, never bought. So are the signs,
 * since the player card has no sign on it any more (2026-10-20).
 */
export type Prize = { id: string; kind: PrizeKind; price: number; earned?: true; retired?: true }

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
  { id: 't-insert', kind: 'title', price: 50, retired: true },
  { id: 't-start', kind: 'title', price: 50, retired: true },
  { id: 't-masher', kind: 'title', price: 60, retired: true },
  { id: 't-snack', kind: 'title', price: 60, retired: true },
  { id: 't-owl', kind: 'title', price: 80, retired: true },
  { id: 't-early', kind: 'title', price: 80, retired: true },
  { id: 't-onemore', kind: 'title', price: 80, retired: true },
  { id: 't-rage', kind: 'title', price: 100, retired: true },
  { id: 't-tutorial', kind: 'title', price: 100, retired: true },
  { id: 't-couch', kind: 'title', price: 120, retired: true },
  { id: 't-bugmagnet', kind: 'title', price: 120, retired: true },
  { id: 't-lurker', kind: 'title', price: 150, retired: true },
  { id: 't-rat', kind: 'title', price: 300, retired: true },
  { id: 't-jockey', kind: 'title', price: 350, retired: true },
  { id: 't-muncher', kind: 'title', price: 350, retired: true },
  { id: 't-hoarder', kind: 'title', price: 400, retired: true },
  { id: 't-cannon', kind: 'title', price: 450, retired: true },
  { id: 't-twist', kind: 'title', price: 500, retired: true },
  { id: 't-main', kind: 'title', price: 600, retired: true },
  { id: 't-bossmusic', kind: 'title', price: 700, retired: true },
  { id: 't-secret', kind: 'title', price: 900, retired: true },
  { id: 't-egg', kind: 'title', price: 1000, retired: true },
  { id: 't-extralife', kind: 'title', price: 1200, retired: true },
  { id: 't-finalboss', kind: 'title', price: 1500, retired: true },
  { id: 'sign-led', kind: 'sign', price: 4000, retired: true },
  { id: 'sign-marquee', kind: 'sign', price: 6500, retired: true },
  { id: 'sign', kind: 'sign', price: 10_000, retired: true },
  { id: 'sign-rooftop', kind: 'sign', price: 15_000, retired: true },
  // The Hangar: skins for good, not a season's (skins.ts HANGAR_SKINS), each a game's ship, car or tail. Never
  // a season's own skin, which only its pass gives. Worn on a game's page, as a season skin is.
  { id: 'hotlap-green-flash', kind: 'skin', price: 1000 },
  { id: 'lander-gold', kind: 'skin', price: 1500 },
  { id: 'asteroids-retro', kind: 'skin', price: 800 },
  { id: 'barrage-paper-plane', kind: 'skin', price: 1200 },
  { id: 'snake-candy-stripe', kind: 'skin', price: 800 },
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
  // The pass's level 28 was this sign until the player card lost its sign (2026-10-20): kept for whoever has it.
  { id: 'sign-liftoff', kind: 'sign', price: 0, earned: true, retired: true },
  // A card foil: a sheen over the player's full-art card, whatever background is under it.
  { id: 'fl-liftoff', kind: 'foil', price: 0, earned: true },
  // Season 1's Pass+ row (seasons.ts), never traded for.
  { id: 'nm-aurora', kind: 'name', price: 0, earned: true },
  { id: 'cd-mission', kind: 'card', price: 0, earned: true },
  { id: 'cf-meteors', kind: 'confetti', price: 0, earned: true },
  { id: 't-commander', kind: 'title', price: 0, earned: true },
  { id: 'eclipse', kind: 'finish', price: 0, earned: true },
  { id: 't-flight-director', kind: 'title', price: 0, earned: true },
  { id: 'nm-telemetry', kind: 'name', price: 0, earned: true },
  { id: 'cd-porthole', kind: 'card', price: 0, earned: true },
  { id: 'cf-splashdown', kind: 'confetti', price: 0, earned: true },
  { id: 'blue-marble', kind: 'finish', price: 0, earned: true },
  { id: 't-ace-pilot', kind: 'title', price: 0, earned: true },
  { id: 'cd-station', kind: 'card', price: 0, earned: true },
  { id: 'nm-wormhole', kind: 'name', price: 0, earned: true },
  { id: 'black-hole', kind: 'finish', price: 0, earned: true },
  { id: 't-legend', kind: 'title', price: 0, earned: true },
  // Season 1's goal of keeping the Dailies on 24 of its days (seasons.ts).
  { id: 't-regular', kind: 'title', price: 0, earned: true },
  // Season 2, Cold Snap: its pass (seasons.ts), never traded for.
  { id: 't-cold-snap', kind: 'title', price: 0, earned: true },
  { id: 't-snow-day', kind: 'title', price: 0, earned: true },
  { id: 't-hot-cocoa', kind: 'title', price: 0, earned: true },
  { id: 't-first-frost', kind: 'title', price: 0, earned: true },
  { id: 't-snow-bunny', kind: 'title', price: 0, earned: true },
  { id: 'nm-frost', kind: 'name', price: 0, earned: true },
  { id: 'nm-frostbite', kind: 'name', price: 0, earned: true },
  { id: 'nm-glacier', kind: 'name', price: 0, earned: true },
  { id: 'snowflake', kind: 'finish', price: 0, earned: true },
  { id: 'igloo', kind: 'finish', price: 0, earned: true },
  { id: 'snowman', kind: 'finish', price: 0, earned: true },
  { id: 'blizzard', kind: 'finish', price: 0, earned: true },
  { id: 'cd-snowfield', kind: 'card', price: 0, earned: true },
  { id: 'cd-ski-lodge', kind: 'card', price: 0, earned: true },
  { id: 'cd-pine-forest', kind: 'card', price: 0, earned: true },
  { id: 'cf-snowfall', kind: 'confetti', price: 0, earned: true },
  { id: 'cf-snowballs', kind: 'confetti', price: 0, earned: true },
  // The pass's level 28 was this sign until the player card lost its sign (2026-10-20): kept for whoever has it.
  { id: 'sign-cold-snap', kind: 'sign', price: 0, earned: true, retired: true },
  // A card foil: a sheen over the player's full-art card, whatever background is under it.
  { id: 'fl-frost', kind: 'foil', price: 0, earned: true },
  // Season 2's Pass+ row (seasons.ts), never traded for.
  { id: 't-snow-angel', kind: 'title', price: 0, earned: true },
  { id: 't-ice-cold', kind: 'title', price: 0, earned: true },
  { id: 't-polar-explorer', kind: 'title', price: 0, earned: true },
  { id: 't-cold-legend', kind: 'title', price: 0, earned: true },
  { id: 'nm-hoarfrost', kind: 'name', price: 0, earned: true },
  { id: 'nm-polar', kind: 'name', price: 0, earned: true },
  { id: 'nm-crystal', kind: 'name', price: 0, earned: true },
  { id: 'cd-frozen-lake', kind: 'card', price: 0, earned: true },
  { id: 'cd-ice-cave', kind: 'card', price: 0, earned: true },
  { id: 'cd-northern-lights', kind: 'card', price: 0, earned: true },
  { id: 'cf-icicles', kind: 'confetti', price: 0, earned: true },
  { id: 'cf-flurry', kind: 'confetti', price: 0, earned: true },
  { id: 'polar-bear', kind: 'finish', price: 0, earned: true },
  { id: 'diamond-dust', kind: 'finish', price: 0, earned: true },
  { id: 'ice-crown', kind: 'finish', price: 0, earned: true },
  // Season 2's goal of keeping the Dailies on 30 of its days (seasons.ts).
  { id: 't-snowbound', kind: 'title', price: 0, earned: true },
  // Plus: each month's look, given to every member that month (plus.ts), never traded for.
  { id: 't-founder', kind: 'title', price: 0, earned: true },
  { id: 'nm-prism', kind: 'name', price: 0, earned: true },
  { id: 'cd-snowglobe', kind: 'card', price: 0, earned: true },
  { id: 'cf-streamers', kind: 'confetti', price: 0, earned: true },
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
