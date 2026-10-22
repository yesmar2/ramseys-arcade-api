import crypto from 'node:crypto'
import { desc, eq, lte } from 'drizzle-orm'
import { db } from './db/client.js'
import { feedback } from './db/schema.js'

/*
 * What players tell the arcade: an idea or a game they'd like, or something
 * that broke. Sent from the site's "Tell us" panel, read on its admin page.
 */

export type FeedbackKind = 'idea' | 'problem'

export type FeedbackInput = {
  kind: FeedbackKind
  message: string
  path?: string
}

export async function recordFeedback(
  input: FeedbackInput,
  from: { accountId?: string | null; name?: string | null; userAgent: string },
  now = Date.now(),
): Promise<void> {
  await db()
    .insert(feedback)
    .values({
      id: crypto.randomUUID(),
      kind: input.kind,
      message: input.message.trim().slice(0, 2000),
      path: input.path?.slice(0, 300) || null,
      accountId: from.accountId ?? null,
      name: from.name?.slice(0, 24) || null,
      userAgent: from.userAgent.slice(0, 300) || null,
      createdAt: now,
    })
}

/** The latest first. */
export async function listFeedback(limit = 100) {
  return db().select().from(feedback).orderBy(desc(feedback.createdAt)).limit(limit)
}

/** One message off an admin's list, once it's dealt with: gone for good. */
export async function removeFeedback(id: string): Promise<boolean> {
  const gone = await db().delete(feedback).where(eq(feedback.id, id)).returning({ id: feedback.id })
  return gone.length > 0
}

/**
 * Every message sent by `before`: the newest on the list the admin cleared. One sent since they loaded it
 * stays, so nothing goes unread.
 */
export async function clearFeedback(before: number): Promise<number> {
  const gone = await db().delete(feedback).where(lte(feedback.createdAt, before)).returning({ id: feedback.id })
  return gone.length
}
