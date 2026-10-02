import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta } from './db/schema.js'

/*
 * Whether the arcade's own rolling events run: the daily event, the One Shot and the Weekly Triple
 * (tournaments.ts buildDailyEvent and the rest). Ramsey chose to launch with them paused (2026-10-02): with
 * few players they'd sit empty, a lone entrant would take the trophy, and they'd crowd the Dailies. Events
 * players run themselves carry on either way.
 *
 * Paused, none is made, and the official events (running or ended) are left out of every list the site
 * reads, so their cards and the Dailies' bonus punches go with them. An admin turns them back on from the
 * admin page (POST /admin/site-events), stored in app_meta, with no release needed. No row means paused.
 */

const KEY = 'site_events'
/** Read again at most this often: every events list asks. */
const FRESH_MS = 30_000

let known: { on: boolean; at: number } | null = null
let asking: Promise<boolean> | null = null

export async function siteEventsOn(now = Date.now()): Promise<boolean> {
  if (known && now - known.at < FRESH_MS) return known.on
  asking ??= db()
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, KEY))
    .limit(1)
    .then(([row]) => {
      known = { on: row?.value === 'on', at: Date.now() }
      return known.on
    })
    .catch(() => known?.on ?? false)
    .finally(() => {
      asking = null
    })
  return asking
}

export async function setSiteEvents(on: boolean): Promise<boolean> {
  const value = on ? 'on' : 'paused'
  await db().insert(appMeta).values({ key: KEY, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } })
  known = { on, at: Date.now() }
  return on
}
