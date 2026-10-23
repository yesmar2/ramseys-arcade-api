import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta } from './db/schema.js'
import { sendToAdmins } from './errorAlerts.js'

/*
 * New feedback from the Tell us panel, pushed to the admins' devices, as Ramsey asked before launch (2026-10-23:
 * "feedback push sounds good too"), so a player's message is heard in minutes rather than at the next look at the
 * admin page. The first message pushes at once. Any more within the next few minutes wait and go as one push
 * that counts them, so a busy hour can't bury the phone (the feedback route's own limit is 300 an hour).
 *
 * It goes at any hour, like the error alerts (errorAlerts.ts sendToAdmins: urgent, each push its own tag). An
 * admin turns it off and on from the admin page's Feedback section (POST /admin/feedback-push), kept in app_meta.
 * No row means on.
 */

const KEY = 'feedback_push'
/** Read again at most this often. */
const FRESH_MS = 30_000

/** After a push, how long more feedback waits to go together: FEEDBACK_PUSH_HOLD_MS, or five minutes. */
function holdMs(): number {
  const set = Number(process.env.FEEDBACK_PUSH_HOLD_MS)
  return Number.isFinite(set) && set >= 0 ? set : 5 * 60_000
}

let known: { on: boolean; at: number } | null = null

export async function feedbackPushOn(now = Date.now()): Promise<boolean> {
  if (known && now - known.at < FRESH_MS) return known.on
  try {
    const [row] = await db().select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, KEY)).limit(1)
    known = { on: row?.value !== 'off', at: now }
  } catch {
    // The database is down: carry on as last known, or on.
    known = { on: known?.on ?? true, at: now }
  }
  return known.on
}

export async function setFeedbackPush(on: boolean): Promise<boolean> {
  const value = on ? 'on' : 'off'
  await db().insert(appMeta).values({ key: KEY, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } })
  known = { on, at: Date.now() }
  if (!on) held = []
  return on
}

export type NewFeedback = { kind: 'idea' | 'problem'; message: string; name: string | null }

let lastPushAt = 0
let held: NewFeedback[] = []
let timer: ReturnType<typeof setTimeout> | null = null

/** "Swoop froze after the second hill" cut to fit a lock screen. */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

function words(list: NewFeedback[]) {
  const latest = list[list.length - 1]!
  const from = latest.name ? `, from ${latest.name}` : ''
  if (list.length === 1) {
    return {
      title: `${latest.kind === 'problem' ? 'Something broke' : 'An idea'}${from}`,
      body: clip(latest.message, 160),
    }
  }
  return { title: `${list.length} new feedback messages`, body: `The latest${from}: ${clip(latest.message, 120)}` }
}

async function push(list: NewFeedback[]) {
  lastPushAt = Date.now()
  const sent = await sendToAdmins({ ...words(list), href: '/admin/feedback', tag: `admin-feedback-${lastPushAt}` })
  console.log(`[feedback] pushed ${list.length} new ${list.length === 1 ? 'message' : 'messages'} to ${sent} admin devices`)
}

function flush() {
  timer = null
  const list = held
  held = []
  if (list.length) push(list).catch((err) => console.warn('[feedback] the push failed:', err))
}

/** A message was just kept: push it now, or hold it to go with the next few. */
export async function noteNewFeedback(feedback: NewFeedback, now = Date.now()): Promise<void> {
  if (!(await feedbackPushOn(now))) return
  const wait = lastPushAt + holdMs() - now
  if (wait <= 0 && !timer) {
    await push([feedback])
    return
  }
  held.push(feedback)
  timer ??= setTimeout(flush, Math.max(0, wait))
  timer.unref?.()
}
