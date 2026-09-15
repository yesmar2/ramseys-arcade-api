/**
 * Avatars: a shape plus two palette colours, saved as one short string on a
 * name claim — `a1:<shape>:<body>:<accent>`. The API only needs to know
 * what is well-formed and what a tag gets by default; the drawing lives in
 * the app. Keep in step with the frontend `src/lib/avatars.ts`.
 */

export const AVATAR_SHAPES = [
  'blob',
  'bot',
  'cat',
  'ghost',
  'star',
  'drop',
  'block',
  'mush',
  'alien',
  'fox',
  'skull',
  'slime',
  'gem',
  'bolt',
  'rocket',
  'pad',
] as const

export type AvatarShape = (typeof AVATAR_SHAPES)[number]

/** Palette size. Indices are what get saved, so this only ever grows. */
export const AVATAR_COLOR_COUNT = 12

export type Avatar = { shape: AvatarShape; body: number; accent: number }

/** The saved form. */
export type AvatarId = string

const VERSION = 'a1'

export function encodeAvatar(avatar: Avatar): AvatarId {
  return `${VERSION}:${avatar.shape}:${avatar.body}:${avatar.accent}`
}

export function parseAvatar(value: unknown): Avatar | null {
  if (typeof value !== 'string') return null
  const parts = value.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  const shape = parts[1] as AvatarShape
  if (!(AVATAR_SHAPES as readonly string[]).includes(shape)) return null
  const body = Number(parts[2])
  const accent = Number(parts[3])
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < AVATAR_COLOR_COUNT
  if (!inRange(body) || !inRange(accent)) return null
  return { shape, body, accent }
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

/** Stable default when a tag has no saved avatar — the same maths as the app. */
export function defaultAvatarId(name: string): AvatarId {
  const hash = hashName(name)
  const shape = AVATAR_SHAPES[hash % AVATAR_SHAPES.length]!
  const body = Math.floor(hash / 8) % AVATAR_COLOR_COUNT
  const accent = (body + 1 + (Math.floor(hash / 97) % (AVATAR_COLOR_COUNT - 1))) % AVATAR_COLOR_COUNT
  return encodeAvatar({ shape, body, accent })
}

export function randomAvatarId(rand: () => number = Math.random): AvatarId {
  const shape = AVATAR_SHAPES[Math.floor(rand() * AVATAR_SHAPES.length)]!
  const body = Math.floor(rand() * AVATAR_COLOR_COUNT)
  let accent = Math.floor(rand() * (AVATAR_COLOR_COUNT - 1))
  if (accent >= body) accent += 1
  return encodeAvatar({ shape, body, accent })
}
