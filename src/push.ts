import { and, eq, sql } from 'drizzle-orm'
import webpush from 'web-push'
import { db } from './db/client.js'
import { pushLedger, pushSubscriptions } from './db/schema.js'
import { PUSHABLE, type NotificationKind } from './notifications.js'

/**
 * Web push, deliberately narrow.
 *
 * Three things keep this from becoming spam, and all three are enforced here
 * rather than left to callers:
 *
 *  1. Only `PUSHABLE` kinds are ever sent (bracket clocks).
 *  2. Quiet hours — a 24h match window otherwise fires at 3am.
 *  3. A hard daily cap per account, so a future caller that forgets the rules
 *     still cannot flood anyone.
 */

/** Nothing goes out between these hours in the device's own zone. */
const QUIET_START_HOUR = 22
const QUIET_END_HOUR = 8

/** Hard ceiling per account per day, regardless of what callers ask for. */
export const DAILY_PUSH_CAP = 2

let configured: boolean | null = null

function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:hello@skermix.com'
  if (!publicKey || !privateKey) return null
  return { publicKey, privateKey, subject }
}

export function publicVapidKey(): string | null {
  return vapid()?.publicKey ?? null
}

function ensureConfigured(): boolean {
  if (configured != null) return configured
  const keys = vapid()
  if (!keys) {
    configured = false
    return false
  }
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
  configured = true
  return true
}

/** Local wall-clock hour for an IANA zone, falling back to UTC. */
function hourIn(zone: string | null, now: number): number {
  if (!zone) return new Date(now).getUTCHours()
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      hour12: false,
    })
    return Number(fmt.format(new Date(now)))
  } catch {
    return new Date(now).getUTCHours()
  }
}

/** `YYYYMMDD` in the device's own zone, so the cap resets at their midnight. */
function localDayKey(zone: string | null, now: number): number {
  const d = new Date(now)
  if (!zone) {
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
    return Number(parts.replaceAll('-', ''))
  } catch {
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  }
}

export function inQuietHours(zone: string | null, now: number): boolean {
  const hour = hourIn(zone, now)
  // The window wraps midnight, so this is an OR rather than a range test.
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
}

export type PushStatus = {
  available: boolean
  enabled: boolean
  devices: number
}

export async function pushStatus(accountId: string): Promise<PushStatus> {
  const rows = await db()
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.accountId, accountId))
  return {
    available: Boolean(publicVapidKey()),
    enabled: rows.length > 0,
    devices: rows.length,
  }
}

export type SubscriptionInput = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  timeZone?: string
}

export async function savePushSubscription(
  accountId: string,
  sub: SubscriptionInput,
  now = Date.now(),
) {
  await db()
    .insert(pushSubscriptions)
    .values({
      id: `ps-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      timeZone: sub.timeZone ?? null,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        accountId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        timeZone: sub.timeZone ?? null,
        lastSeenAt: now,
        // A re-subscribe clears an earlier delivery failure.
        failedAt: null,
      },
    })
}

export async function disablePush(accountId: string, endpoint?: string) {
  const scope = endpoint
    ? and(
        eq(pushSubscriptions.accountId, accountId),
        eq(pushSubscriptions.endpoint, endpoint),
      )
    : eq(pushSubscriptions.accountId, accountId)
  await db().delete(pushSubscriptions).where(scope)
}

async function dropEndpoint(endpoint: string) {
  await db().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
}

export type PushPayload = {
  kind: NotificationKind
  title: string
  body?: string | null
  href?: string | null
  /** One push per transition, ever — e.g. `match-open:m-1-3`. */
  dedupeKey: string
}

export type PushOutcome =
  | 'sent'
  | 'not-configured'
  | 'not-pushable'
  | 'no-devices'
  | 'quiet-hours'
  | 'capped'
  | 'duplicate'

/**
 * Deliver one notification to a player's devices, if every guardrail agrees.
 *
 * Returns why it did not send rather than throwing, so callers can log the
 * reason without having to care.
 */
export async function sendPush(
  accountId: string,
  payload: PushPayload,
  now = Date.now(),
): Promise<PushOutcome> {
  if (!PUSHABLE.has(payload.kind)) return 'not-pushable'
  if (!ensureConfigured()) return 'not-configured'

  const devices = await db()
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.accountId, accountId))
  if (devices.length === 0) return 'no-devices'

  const zone = devices.find((d) => d.timeZone)?.timeZone ?? null
  if (inQuietHours(zone, now)) return 'quiet-hours'

  const key = localDayKey(zone, now)
  const [ledger] = await db()
    .select()
    .from(pushLedger)
    .where(and(eq(pushLedger.accountId, accountId), eq(pushLedger.dayKey, key)))

  if (ledger?.lastKey === payload.dedupeKey) return 'duplicate'
  if ((ledger?.sent ?? 0) >= DAILY_PUSH_CAP) return 'capped'

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    href: payload.href ?? '/',
    kind: payload.kind,
  })

  let delivered = 0
  for (const device of devices) {
    try {
      await webpush.sendNotification(
        {
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh, auth: device.auth },
        },
        body,
      )
      delivered++
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // 404/410 mean the browser threw the subscription away; stop trying.
      if (status === 404 || status === 410) await dropEndpoint(device.endpoint)
      else {
        await db()
          .update(pushSubscriptions)
          .set({ failedAt: now })
          .where(eq(pushSubscriptions.id, device.id))
      }
    }
  }

  if (delivered === 0) return 'no-devices'

  await db()
    .insert(pushLedger)
    .values({
      id: `pl-${accountId}-${key}`,
      accountId,
      dayKey: key,
      sent: 1,
      lastKey: payload.dedupeKey,
    })
    .onConflictDoUpdate({
      target: [pushLedger.accountId, pushLedger.dayKey],
      set: { sent: sql`${pushLedger.sent} + 1`, lastKey: payload.dedupeKey },
    })

  return 'sent'
}
