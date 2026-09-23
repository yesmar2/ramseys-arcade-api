/**
 * Avatars: the tag's own monogram or an emblem, on a round badge, in two
 * palette colours, with a ring around it and a pin on its edge that the
 * player has earned. One short string, saved on the name claim:
 *
 *   a2:m:<letters>:<pattern>:<body>:<detail>:<badge>:<ring>:<pin>
 *   a2:e:<emblem>:<body>:<detail>:<badge>:<ring>:<pin>
 *
 * A monogram saves how many letters of the tag it shows (1 or 2), not the
 * letters, so it follows a rename and can't spell anything else. Every tag has
 * one before its owner picks: its monogram, coloured from the tag. The API
 * knows what is well-formed, what a tag gets by default, and (in flair.ts)
 * what a player has earned; the drawing lives in the app. Keep in step with
 * the frontend `src/lib/avatars.ts`.
 */

export const AVATAR_EMBLEMS = [
  'joystick',
  'pad',
  'coin',
  'bolt',
  'crown',
  'flame',
  'rocket',
  'planet',
  'ufo',
  'dice',
  'trophy',
  'gem',
  'heart',
  'target',
  'eightball',
  'cabinet',
] as const
export type AvatarEmblem = (typeof AVATAR_EMBLEMS)[number]

export const AVATAR_PATTERNS = ['plain', 'rings', 'split', 'stripes', 'dots', 'burst', 'half'] as const
export type AvatarPattern = (typeof AVATAR_PATTERNS)[number]

export const AVATAR_BADGES = ['bold', 'deep', 'night', 'paper'] as const
export type AvatarBadge = (typeof AVATAR_BADGES)[number]

/** Worn around the badge, for how you've placed. */
export const AVATAR_RINGS = ['bronze', 'silver', 'gold', 'record', 'laurel'] as const
export type AvatarRing = (typeof AVATAR_RINGS)[number]

/** One pin per game on the shelf, for its all-time top ten. */
export const AVATAR_GAME_PINS = [
  'asteroids',
  'patriot',
  'snake',
  'crosswalk',
  'stacker',
  'centroid',
  'pop',
  'pellets',
  'findbug',
  'crumbtrail',
  'bop',
  'putt',
  'barrage',
  'frenzy',
  'fireflies',
] as const

/** Worn on the badge's edge, for what you've done. */
export const AVATAR_PINS = ['welcome', 'games', 'streak', 'crown', ...AVATAR_GAME_PINS] as const
export type AvatarPin = (typeof AVATAR_PINS)[number]

/** Palette size. Indices are what get saved, so this only ever grows. */
export const AVATAR_COLOR_COUNT = 16

type Common = {
  body: number
  detail: number
  badge: AvatarBadge
  ring: AvatarRing | null
  pin: AvatarPin | null
}
export type Avatar = ({ kind: 'mono'; letters: 1 | 2; pattern: AvatarPattern } | { kind: 'emblem'; emblem: AvatarEmblem }) & Common

/** The saved form. */
export type AvatarId = string

const VERSION = 'a2'

export function encodeAvatar(avatar: Avatar): AvatarId {
  const tail = `${avatar.body}:${avatar.detail}:${avatar.badge}:${avatar.ring ?? 'none'}:${avatar.pin ?? 'none'}`
  return avatar.kind === 'mono'
    ? `${VERSION}:m:${avatar.letters}:${avatar.pattern}:${tail}`
    : `${VERSION}:e:${avatar.emblem}:${tail}`
}

function oneOf<T extends string>(list: readonly T[], value: string | undefined): T | null {
  return value != null && (list as readonly string[]).includes(value) ? (value as T) : null
}

export function parseAvatar(value: unknown): Avatar | null {
  if (typeof value !== 'string') return null
  const parts = value.split(':')
  if (parts[0] !== VERSION) return null
  const mono = parts[1] === 'm'
  if (!mono && parts[1] !== 'e') return null
  if (parts.length !== (mono ? 9 : 8)) return null
  const [body, detail, badgeRaw, ringRaw, pinRaw] = parts.slice(mono ? 4 : 3)
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < AVATAR_COLOR_COUNT
  const b = Number(body)
  const d = Number(detail)
  const badge = oneOf(AVATAR_BADGES, badgeRaw)
  const ring = ringRaw === 'none' ? null : oneOf(AVATAR_RINGS, ringRaw)
  const pin = pinRaw === 'none' ? null : oneOf(AVATAR_PINS, pinRaw)
  if (!inRange(b) || !inRange(d) || !badge) return null
  if (ringRaw !== 'none' && !ring) return null
  if (pinRaw !== 'none' && !pin) return null
  const common = { body: b, detail: d, badge, ring, pin }
  if (mono) {
    const letters = parts[2] === '1' ? 1 : parts[2] === '2' ? 2 : null
    const pattern = oneOf(AVATAR_PATTERNS, parts[3])
    if (!letters || !pattern) return null
    return { kind: 'mono', letters, pattern, ...common }
  }
  const emblem = oneOf(AVATAR_EMBLEMS, parts[2])
  if (!emblem) return null
  return { kind: 'emblem', emblem, ...common }
}

export function isAvatarId(value: unknown): value is AvatarId {
  return parseAvatar(value) !== null
}

function hashName(name: string) {
  const cleaned = name.trim().toUpperCase()
  let hash = 0
  for (let i = 0; i < cleaned.length; i++) {
    hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0
  }
  return hash
}

/** A tag's look before anyone picks: its monogram, coloured and patterned from the tag — the same maths as the app. */
export function defaultAvatar(name: string): Avatar {
  const hash = hashName(name)
  const body = Math.floor(hash / 8) % AVATAR_COLOR_COUNT
  const detail = (body + 1 + (Math.floor(hash / 97) % (AVATAR_COLOR_COUNT - 1))) % AVATAR_COLOR_COUNT
  const pattern = AVATAR_PATTERNS[1 + (hash % (AVATAR_PATTERNS.length - 1))]!
  return { kind: 'mono', letters: 1, pattern, body, detail, badge: 'bold', ring: null, pin: null }
}

export function defaultAvatarId(name: string): AvatarId {
  return encodeAvatar(defaultAvatar(name))
}

/** A made-up look for a seeded player: about half monograms, half emblems, nothing earned. */
export function randomAvatarId(rand: () => number = Math.random): AvatarId {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!
  const body = Math.floor(rand() * AVATAR_COLOR_COUNT)
  let detail = Math.floor(rand() * (AVATAR_COLOR_COUNT - 1))
  if (detail >= body) detail += 1
  const common = { body, detail, ring: null, pin: null }
  if (rand() < 0.5) {
    return encodeAvatar({
      kind: 'mono',
      letters: rand() < 0.2 ? 2 : 1,
      pattern: pick(AVATAR_PATTERNS),
      badge: pick(['bold', 'bold', 'bold', 'deep', 'night', 'paper'] as const),
      ...common,
    })
  }
  return encodeAvatar({
    kind: 'emblem',
    emblem: pick(AVATAR_EMBLEMS),
    badge: pick(['deep', 'deep', 'bold', 'night', 'paper'] as const),
    ...common,
  })
}
