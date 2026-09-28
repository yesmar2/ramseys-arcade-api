/*
 * A copy of the site's src/lib/seededRandom.ts (ramseys-arcade), kept identical but for its imports, so the API builds
 * the same day of glasses and scores a pour to the same figure. Change both together;
 * `npm run check:halffull` compares them day by day.
 */

/**
 * Small deterministic RNG shared by seeded content (Find the Bug scenes today,
 * the site-wide daily hunt later).
 */

export function hashString(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
