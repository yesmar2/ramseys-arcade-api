import { desc, gte, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { sourceDays } from './db/schema.js'
import { boardDateKey } from './store.js'

/*
 * Where players came from, for paid ads and any other link worth counting (Ramsey, 2026-11-17: "why are we not
 * looking into the route of putting an ad out"). A link carries a tag (blipka.com/games/lander/play?src=rd-lander),
 * the site's lib/source.ts keeps it on the device that came in on it, and says here, once each:
 *   arrive  the first visit on the tag
 *   stay    that first day, the page stayed open a minute (a fair sign they played)
 *   back    the first later day they came back
 *   day     each later day they came back
 * Daily counts per tag only: no account, address or device id. The admin page's Ad links card reads them.
 */

export const KINDS = ['arrive', 'stay', 'back', 'day'] as const
export type SourceKind = (typeof KINDS)[number]

/** A tag as links carry it. */
export const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/

export async function recordSource(src: string, kind: SourceKind, now = Date.now()): Promise<void> {
  await db()
    .insert(sourceDays)
    .values({ day: boardDateKey(now), src, kind, count: 1 })
    .onConflictDoUpdate({ target: [sourceDays.day, sourceDays.src, sourceDays.kind], set: { count: sql`${sourceDays.count} + 1` } })
}

export type SourceTotals = Record<SourceKind, number>
export type SourceReport = {
  /** The first day counted (YYYYMMDD). */
  since: number
  tags: { src: string; totals: SourceTotals; days: { day: number; counts: SourceTotals }[]; last: number }[]
}

const empty = (): SourceTotals => ({ arrive: 0, stay: 0, back: 0, day: 0 })

/** Every tag seen in the last `days` days, the busiest first, with its counts in all and day by day. */
export async function sourcesReport(days = 30, now = Date.now()): Promise<SourceReport> {
  const since = boardDateKey(now - (days - 1) * 86_400_000)
  const rows = await db().select().from(sourceDays).where(gte(sourceDays.day, since)).orderBy(desc(sourceDays.day))
  const byTag = new Map<string, SourceReport['tags'][number]>()
  for (const row of rows) {
    if (!(KINDS as readonly string[]).includes(row.kind)) continue
    const kind = row.kind as SourceKind
    let tag = byTag.get(row.src)
    if (!tag) {
      tag = { src: row.src, totals: empty(), days: [], last: row.day }
      byTag.set(row.src, tag)
    }
    tag.totals[kind] += row.count
    let day = tag.days.find((d) => d.day === row.day)
    if (!day) {
      day = { day: row.day, counts: empty() }
      tag.days.push(day)
    }
    day.counts[kind] += row.count
    if (row.day > tag.last) tag.last = row.day
  }
  const tags = [...byTag.values()].sort((a, b) => b.totals.arrive - a.totals.arrive || b.last - a.last)
  return { since, tags }
}
