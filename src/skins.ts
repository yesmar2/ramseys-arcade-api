import { getClaim } from './names.js'
import { SEASON_SKINS } from './seasons.js'
import { ownedPrizes } from './tickets.js'

/*
 * Skins on runs: a saved run says which skin it was played in (the site's lib/skins.ts), so ghosts, boards and
 * challenge links can show it to everyone. Looks only: a skin is never part of a score. A skin is a season's
 * (its pass gives it: seasons.ts), the Hangar's (traded for tickets at the prize counter: prizes.ts) or one of
 * Blip's (won by answering his daily question: poll.ts).
 */

/** The Hangar's skins and their games: for good, traded for tickets, never a season's. */
export const HANGAR_SKINS: ReadonlyMap<string, string> = new Map([
  ['hotlap-green-flash', 'hotlap'],
  ['lander-gold', 'lander'],
  ['asteroids-retro', 'asteroids'],
  ['barrage-paper-plane', 'barrage'],
  ['snake-candy-stripe', 'snake'],
])

/**
 * Blip's set and their games, in the order his daily question wins them (poll.ts): the first after
 * BLIP_SKIN_EVERY answers, the next after twice that, and so on (Ramsey, 2026-10-11: "i like A, daily question 7
 * times"). For good, never a season's, never for tickets.
 */
export const BLIP_SKINS: readonly (readonly [string, string])[] = [
  ['pellets-blip', 'pellets'],
  ['swoop-blip', 'swoop'],
  ['frenzy-blip', 'frenzy'],
  ['marblerun-blip', 'marblerun'],
]

/** How many answers to Blip's question win each skin of his set. */
export const BLIP_SKIN_EVERY = 7

/** Every skin there is, season's, Hangar's and Blip's, and its game. */
const ALL_SKINS: ReadonlyMap<string, string> = new Map([...SEASON_SKINS, ...HANGAR_SKINS, ...BLIP_SKINS])

/** The skin a run says it was played in, if it's one of that game's and the account owns it; else none. */
export async function runSkin(accountId: string, game: string, skin: string | null | undefined): Promise<string | null> {
  if (!skin || ALL_SKINS.get(skin) !== game) return null
  return (await ownedPrizes(accountId)).has(skin) ? skin : null
}

/** The skins a tag's player has, won or traded for, for their hangar on the player card. Null for a tag nobody holds. */
export async function skinsOfName(name: string): Promise<string[] | null> {
  const claim = await getClaim(name)
  if (!claim?.accountId) return null
  const owned = await ownedPrizes(claim.accountId)
  return [...ALL_SKINS.keys()].filter((id) => owned.has(id))
}
