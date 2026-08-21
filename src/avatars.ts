/** Curated avatar ids — keep in sync with frontend `src/lib/avatars.ts`. */
export const AVATAR_IDS = [
  'orb',
  'bolt',
  'ship',
  'star',
  'pulse',
  'chip',
  'ring',
  'wave',
  'coin',
  'spark',
  'cube',
  'nova',
  'pixel',
  'arrow',
  'hex',
  'glow',
  'disc',
  'beam',
  'core',
  'flare',
] as const

export type AvatarId = (typeof AVATAR_IDS)[number]

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value)
}

/** Stable default when a tag has no saved avatar. */
export function defaultAvatarId(name: string): AvatarId {
  const cleaned = name.trim().toUpperCase()
  let hash = 0
  for (let i = 0; i < cleaned.length; i++) {
    hash = (hash * 31 + cleaned.charCodeAt(i)) >>> 0
  }
  return AVATAR_IDS[hash % AVATAR_IDS.length]
}
