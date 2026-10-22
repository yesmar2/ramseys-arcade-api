import crypto from 'node:crypto'
import { db } from './db/client.js'
import { shareEvents } from './db/schema.js'
import { resolveGameSlug } from './store.js'

/*
 * Each time a player sends something on from the site: through the share sheet on a phone, or Copy on a
 * computer. Every share button goes one way (the site's lib/share.ts shareOrCopy), and it says so here once
 * it has gone. Kept: what kind of link it was and the game it was about, and the account when signed in.
 * Never who it went to, or the words. The admin page counts them (launchNumbers.ts): do players share is the
 * second of the three numbers Ramsey watches from launch.
 */

/** A link's kind, as the site sends it: the first part of its path ('today', 'c', 'e', …), or 'text'. */
const KIND = /^[a-z0-9-]{1,24}$/

/** sheet: the device's share sheet. copy: the clipboard. place: one of the share panel's Messages, Email, X, Facebook. */
export type ShareNote = { kind: string; game?: string | null; how: 'sheet' | 'copy' | 'place' }

export async function recordShare(note: ShareNote, accountId: string | null, now = Date.now()): Promise<void> {
  await db()
    .insert(shareEvents)
    .values({
      id: crypto.randomBytes(12).toString('base64url'),
      at: now,
      kind: KIND.test(note.kind) ? note.kind : 'other',
      game: note.game ? resolveGameSlug(note.game.trim().toLowerCase()) : null,
      how: note.how,
      accountId,
    })
}
