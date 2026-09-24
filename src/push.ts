import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import webpush from 'web-push'
import { db } from './db/client.js'
import { notifications, pushLedger, pushSubscriptions } from './db/schema.js'
import {
  MATCH_KINDS,
  PUSHABLE,
  markPushed,
  notify,
  type NotificationKind,
  type NotificationRow,
  type NotifyInput,
} from './notifications.js'
import { timeLeft } from './words.js'

/**
 * Web push, deliberately narrow.
 *
 * Three things keep this from becoming spam, and all three are enforced here
 * rather than left to callers:
 *
 *  1. Only `PUSHABLE` kinds are ever sent (bracket clocks, a beaten challenge).
 *  2. Quiet hours — a 24h match window otherwise fires at 3am. What quiet
 *     hours hold back goes out when they end, if it still matters then.
 *  3. A hard daily cap per account, so a future caller that forgets the rules
 *     still cannot flood anyone.
 *
 * A notification row remembers when it was pushed, so each alert goes to a
 * phone once however many times it is filed or retried.
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
  /**
   * The phone keeps one card per tag, so each alert needs its own: tagged by
   * kind, a second match's alert replaced the first on the lock screen.
   */
  tag?: string
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
    tag: payload.tag ?? payload.dedupeKey,
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

/* ------------------------------------------------ one row, one push --- */

/** Past this, an alert that never got out is old news and stays in the inbox. */
const HOLD_FOR_MS = 18 * 60 * 60 * 1000

/**
 * A match alert's title says how long is left, which is only true when it's
 * written: one held back overnight is told again with the time left now.
 */
function pushTitle(row: NotificationRow, now: number): string {
  const endsAt = row.meta?.endsAt
  const actor = row.meta?.actor
  if (row.kind === 'match-closing' && endsAt && actor) return `${timeLeft(endsAt - now)} left against ${actor}`
  return row.title
}

/** Whether a row still deserves a buzz: pushable, unsent, unanswered, and not over. */
function stillWorthPushing(row: NotificationRow, now: number): boolean {
  if (!PUSHABLE.has(row.kind) || row.pushedAt != null || row.resolvedAt != null) return false
  if (now - row.createdAt > HOLD_FOR_MS) return false
  const endsAt = row.meta?.endsAt
  // A match with minutes left is better told in the inbox than on a lock screen.
  if (MATCH_KINDS.has(row.kind) && endsAt != null && endsAt - now < 10 * 60_000) return false
  return true
}

/** Push one row to its player's devices, once. */
export async function deliver(row: NotificationRow, now = Date.now()): Promise<PushOutcome | 'skipped'> {
  if (!stillWorthPushing(row, now)) return 'skipped'
  const key = row.digestKey ?? row.id
  const outcome = await sendPush(
    row.accountId,
    { kind: row.kind, title: pushTitle(row, now), body: row.body, href: row.href, dedupeKey: key, tag: key },
    now,
  )
  // A duplicate was pushed before this row remembered it; either way it's out.
  if (outcome === 'sent' || outcome === 'duplicate') await markPushed(row.id, now)
  return outcome
}

/** File a notification and, when it's new and one of the kinds that buzz, push it. */
export async function fileAndPush(input: NotifyInput) {
  const now = input.now ?? Date.now()
  const filed = await notify(input)
  if (filed.created && PUSHABLE.has(input.kind)) {
    await deliver(filed.row, now).catch((err: unknown) => {
      console.warn(`[push] ${input.kind} for ${input.accountId} failed:`, err)
    })
  }
  return filed
}

/**
 * Send what quiet hours or the daily cap held back, now that they allow it.
 * Runs from the sweep; only players with a device are looked at.
 */
export async function pushHeld(now = Date.now()): Promise<number> {
  if (!ensureConfigured()) return 0
  const rows = (await db()
    .select()
    .from(notifications)
    .where(
      and(
        inArray(notifications.kind, [...PUSHABLE]),
        isNull(notifications.pushedAt),
        isNull(notifications.resolvedAt),
        gt(notifications.createdAt, now - HOLD_FOR_MS),
      ),
    )) as NotificationRow[]
  const due = rows.filter((row) => stillWorthPushing(row, now))
  if (!due.length) return 0
  const accounts = [...new Set(due.map((r) => r.accountId))]
  const withDevices = new Set(
    (
      await db()
        .selectDistinct({ accountId: pushSubscriptions.accountId })
        .from(pushSubscriptions)
        .where(inArray(pushSubscriptions.accountId, accounts))
    ).map((r) => r.accountId),
  )
  let sent = 0
  for (const row of due.sort((a, b) => a.createdAt - b.createdAt)) {
    if (!withDevices.has(row.accountId)) continue
    if ((await deliver(row, now)) === 'sent') sent++
  }
  return sent
}
