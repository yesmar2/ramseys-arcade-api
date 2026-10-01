import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from './db/client.js'
import { notifications, pushSubscriptions } from './db/schema.js'
import { notify } from './notifications.js'
import { hourIn, inQuietHours, streakRiskTitle } from './push.js'
import { boardDateKey, boardDayStart } from './store.js'
import { keptToday, streakRiskKey, todayState } from './today.js'

/*
 * The Dailies streak reminder: on an evening when a player's streak would end with the day, one note to
 * say so, with how long is left and how many dailies still keep it.
 *
 * Only players with alerts on a device are looked at: the reminder is there to reach someone who isn't on
 * the site, and anyone who is sees the Dailies chip. It goes the way their settings say ('streak-risk',
 * pushed by default), never in quiet hours, at most once a day, and it's taken back the moment the day is
 * kept (today.ts settleToday). A day's reminder is gone from the inbox once its day is over, kept or not.
 *
 * The boards' day is New York's, and it ends at a different hour on every device. The reminder goes in the
 * day's last five hours when those are waking hours on the device: from 7pm in New York, 4pm in California,
 * 8am in Tokyo. Where the day ends in the device's night (5am in London), the evening before is the last
 * chance awake, so it goes from 7pm there.
 */

/** The reminder goes in the day's last this-many hours... */
const WINDOW_MS = 5 * 3_600_000
/** ...unless they're the device's night: then from this hour the evening before, */
export const REMIND_FROM_HOUR = 19
/** and no further from the end than this. */
const EVENING_BEFORE_MS = 17 * 3_600_000
/** Under this, there isn't time to play the dailies that keep the day: no reminder. */
const TOO_LATE_MS = 45 * 60_000

const dayOf = (key: number) => {
  const s = String(key)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** When the boards' day that `now` is in ends: the next day's first moment (days run 23 to 25 hours). */
export function boardDayEnd(now: number): number {
  return boardDayStart(boardDayStart(now) + 25 * 3_600_000)
}

/** Whether a device in `zone` is due its reminder now, for a day ending at `endsAt`. */
export function reminderDue(zone: string | null, now: number, endsAt: number): boolean {
  const left = endsAt - now
  if (left < TOO_LATE_MS || inQuietHours(zone, now)) return false
  // The day's last hours start at a waking hour on this device: the reminder goes in them.
  if (!inQuietHours(zone, endsAt - WINDOW_MS)) return left <= WINDOW_MS
  // The day ends in this device's night: the evening before is the last chance awake.
  return hourIn(zone, now) >= REMIND_FROM_HOUR && left <= EVENING_BEFORE_MS
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six']

/** "Two more dailies keep it going." Holding a freeze: "…keep it. Miss today and a freeze covers it." */
export function streakRiskBody(left: number, covered = false): string {
  const n = NUMBER_WORDS[left] ?? String(left)
  const keep = left === 1 ? 'One more daily keeps it' : `${n} more dailies keep it`
  return covered ? `${keep}. Miss today and a freeze covers it.` : `${keep} going.`
}

/**
 * Accounts already looked at today and found with nothing at risk: no streak to lose (yesterday wasn't
 * kept), or today kept already. Neither changes before the day ends, so each is looked at once a day.
 */
let checked: { day: string; ids: Set<string> } = { day: '', ids: new Set() }

/** File today's streak reminders that are due. Runs from the sweep. Returns how many were filed. */
export async function remindStreaks(now = Date.now()): Promise<number> {
  const day = dayOf(boardDateKey(now))
  const key = streakRiskKey(day)
  if (checked.day !== day) {
    // A new day (or a fresh start): earlier days' reminders are over, so there's nothing left to do about them.
    await db()
      .delete(notifications)
      .where(and(eq(notifications.kind, 'streak-risk'), ne(notifications.digestKey, key)))
    checked = { day, ids: new Set() }
  }

  const endsAt = boardDayEnd(now)
  if (endsAt - now < TOO_LATE_MS) return 0

  // Each account's zone: the first of its devices that told us one, as push.ts reads it for quiet hours.
  const devices = await db()
    .select({ accountId: pushSubscriptions.accountId, timeZone: pushSubscriptions.timeZone })
    .from(pushSubscriptions)
  const zones = new Map<string, string | null>()
  for (const d of devices) {
    if (!zones.get(d.accountId)) zones.set(d.accountId, d.timeZone ?? null)
  }
  const due = [...zones]
    .filter(([id, zone]) => !checked.ids.has(id) && reminderDue(zone, now, endsAt))
    .map(([id]) => id)
  if (!due.length) return 0

  const told = new Set(
    (
      await db()
        .select({ accountId: notifications.accountId })
        .from(notifications)
        .where(and(inArray(notifications.accountId, due), eq(notifications.digestKey, key)))
    ).map((r) => r.accountId),
  )

  let filed = 0
  for (const accountId of due) {
    if (told.has(accountId)) continue
    const state = await todayState(accountId, now)
    const streak = state.streak.current
    if (streak < 1 || keptToday(state)) {
      checked.ids.add(accountId)
      continue
    }
    const left = state.need - state.live.filter((k) => state.done[k]).length
    // Holding a freeze, missing today won't end the streak: still worth a nudge, said honestly.
    const covered = state.freezes.held > 0
    const result = await notify({
      accountId,
      kind: 'streak-risk',
      title: streakRiskTitle(streak, endsAt - now, covered),
      body: streakRiskBody(left, covered),
      href: '/dailies',
      meta: { endsAt, streak, left, covered },
      digestKey: key,
      once: true,
      now,
    })
    if (result.row) filed++
    // Turned off in their settings: nothing to file today, so nothing to look at again.
    else checked.ids.add(accountId)
  }
  return filed
}
