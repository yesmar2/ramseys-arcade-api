import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { isAdminEmail } from './admin.js'
import { db } from './db/client.js'
import { accounts, pushSubscriptions } from './db/schema.js'
import { pushToDevices, type PushDevice } from './push.js'

/*
 * The admins hear on their phones when errors spike (the launch checklist's "Push you when errors spike"):
 * - **site:** errors from players' browsers (clientErrorsRoutes.ts).
 * - **api:** this API's own failed answers (index.ts).
 *
 * Each is counted over the last ten minutes in this server's memory. MULTI_INSTANCE is off, so one server sees
 * them all; with more, each would count its own share. Past a spike, every admin's devices get a push, at most
 * one an hour for each kind, at any hour. The admins' devices are kept in memory too, so a push still goes out
 * when the database is what's failing.
 */

type Kind = 'site' | 'api'
type Seen = { at: number; what: string; who: string }

const WINDOW_MS = 10 * 60_000
/** After an alert, the same kind stays quiet this long: the admin page has the rest. */
const QUIET_MS = 60 * 60_000
/** A spike: this many in the window, the site's from at least this many players (by address). */
export const SPIKE = { site: { count: 20, players: 5 }, api: { count: 20 } } as const

const seen: Record<Kind, Seen[]> = { site: [], api: [] }
const alertedAt: Record<Kind, number> = { site: 0, api: 0 }

function note(kind: Kind, what: string, who: string, now: number) {
  const list = seen[kind]
  list.push({ at: now, what, who })
  while (list.length && list[0]!.at < now - WINDOW_MS) list.shift()
  // A runaway can't grow this without end: the window's latest are what an alert reads.
  if (list.length > 2000) list.splice(0, list.length - 2000)
  const players = new Set(list.map((s) => s.who)).size
  const spike = kind === 'site' ? list.length >= SPIKE.site.count && players >= SPIKE.site.players : list.length >= SPIKE.api.count
  if (!spike || now - alertedAt[kind] < QUIET_MS) return
  alertedAt[kind] = now
  alert(kind, list, players).catch((err) => console.warn('[error-alerts] the alert failed:', err))
}

/** A player's browser reported an error. `ip` is only counted (hashed), never kept. */
export function noteSiteError(message: string, ip: string, now = Date.now()) {
  note('site', message, crypto.createHash('sha1').update(ip).digest('hex').slice(0, 12), now)
}

/** This API answered with a failure: `what` says which ("500 on GET /season"). */
export function noteApiFailure(what: string, now = Date.now()) {
  note('api', what, '', now)
}

/** The answer's route, with what looks like an id taken out, so one failing route counts as one. */
export function routeLabel(method: string, path: string): string {
  const plain = path
    .split('/')
    .map((part) => (part.length > 24 || (/\d/.test(part) && part.length > 3) ? ':id' : part))
    .join('/')
  return `${method} ${plain.slice(0, 80)}`
}

function mostOf(list: Seen[]): { what: string; times: number } {
  const counts = new Map<string, number>()
  for (const s of list) counts.set(s.what, (counts.get(s.what) ?? 0) + 1)
  let best = { what: '', times: 0 }
  for (const [what, times] of counts) if (times > best.times) best = { what, times }
  return best
}

async function alert(kind: Kind, list: Seen[], players: number) {
  const most = mostOf(list)
  const minutes = WINDOW_MS / 60_000
  const message =
    kind === 'site'
      ? {
          title: 'Site errors are spiking',
          body: `${list.length} from ${players} players in the last ${minutes} minutes. Most: ${most.what.slice(0, 120)} (${most.times})`,
          href: '/admin',
          tag: 'admin-site-errors',
        }
      : {
          title: 'API errors are spiking',
          body: `${list.length} failed answers in the last ${minutes} minutes. Most: ${most.what} (${most.times}). Render's logs have the rest.`,
          href: '/admin',
          tag: 'admin-api-errors',
        }
  const to = await adminDevices()
  const sent = await pushToDevices(to, message)
  console.warn(`[error-alerts] ${message.title}: ${message.body} Pushed to ${sent} of ${to.length} admin devices.`)
}

/* ------------------------------------------------- the admins' devices --- */

const DEVICES_FRESH_MS = 10 * 60_000
let devices: PushDevice[] = []
let devicesAt = 0

/** Every admin's push devices, from the database: a few rows, as only devices with push on are there. */
async function loadAdminDevices(): Promise<PushDevice[]> {
  const rows = await db()
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      email: accounts.email,
    })
    .from(pushSubscriptions)
    .innerJoin(accounts, eq(accounts.id, pushSubscriptions.accountId))
  return rows.filter((row) => isAdminEmail(row.email)).map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }))
}

/** The admins' devices: fresh when the database answers, the last list when it doesn't. */
export async function adminDevices(now = Date.now()): Promise<PushDevice[]> {
  if (now - devicesAt < DEVICES_FRESH_MS) return devices
  try {
    devices = await loadAdminDevices()
    devicesAt = now
  } catch (err) {
    const why = (err as { cause?: unknown }).cause ?? err
    console.warn(`[error-alerts] could not read the admin devices, so the last list stays: ${String(why).split('\n')[0]}`)
  }
  return devices
}

export async function sendToAdmins(message: { title: string; body: string; href: string; tag: string }) {
  return pushToDevices(await adminDevices(), message)
}

/** Keep the list warm, so it's there from before a database outage. */
export function startErrorAlerts() {
  void adminDevices()
  setInterval(() => void adminDevices(), DEVICES_FRESH_MS).unref()
}

/** For the admin page: where alerts would go, and when each kind last went. */
export async function errorAlertsState(now = Date.now()) {
  devicesAt = 0
  const list = await adminDevices(now)
  return {
    devices: list.length,
    spike: SPIKE,
    windowMinutes: WINDOW_MS / 60_000,
    lastAlert: { site: alertedAt.site || null, api: alertedAt.api || null },
  }
}
