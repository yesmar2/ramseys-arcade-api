import crypto from 'node:crypto'
import { desc, lt, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { clientErrors } from './db/schema.js'

/*
 * Errors from players' browsers. The site sends what broke: the message, the
 * top of the stack, the page and the build. The same error again only counts
 * up, so a page that breaks for everyone is one row, not thousands. Admins
 * read them on the site's admin page.
 */

const KEEP_MS = 30 * 24 * 60 * 60_000

export type ClientErrorInput = {
  message: string
  stack?: string
  path?: string
  release?: string
}

/**
 * The same error in any build: its message and its stack's first frame, with
 * each build's file hashes and the line numbers taken out.
 */
function fingerprint(message: string, stack: string): string {
  const frame =
    stack
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('at ') || line.includes('@')) ?? ''
  const plain = (text: string) => text.replace(/-[\w-]{8}\.js/g, '.js').replace(/:\d+(:\d+)?/g, '')
  return crypto.createHash('sha1').update(`${plain(message)}|${plain(frame)}`).digest('hex')
}

export async function recordClientError(
  input: ClientErrorInput,
  userAgent: string,
  now = Date.now(),
): Promise<void> {
  const message = input.message.slice(0, 500)
  const stack = (input.stack ?? '').slice(0, 4000)
  const latest = {
    stack: stack || null,
    path: input.path?.slice(0, 300) || null,
    release: input.release?.slice(0, 64) || null,
    userAgent: userAgent.slice(0, 300) || null,
    lastAt: now,
  }
  await db()
    .insert(clientErrors)
    .values({ fingerprint: fingerprint(message, stack), message, count: 1, firstAt: now, ...latest })
    .onConflictDoUpdate({
      target: clientErrors.fingerprint,
      set: { ...latest, count: sql`${clientErrors.count} + 1` },
    })
}

/** The latest first. */
export async function listClientErrors(limit = 100) {
  return db().select().from(clientErrors).orderBy(desc(clientErrors.lastAt)).limit(limit)
}

export async function pruneClientErrors(now = Date.now()): Promise<void> {
  await db().delete(clientErrors).where(lt(clientErrors.lastAt, now - KEEP_MS))
}
