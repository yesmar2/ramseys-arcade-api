import { asc, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { launchList } from './db/schema.js'
import { BATCH_MAX, sendMail, sendMailBatch, type Mail } from './mailer.js'

/*
 * The launch list (Ramsey, 2026-10-13): until Blipka opens, the site shows anyone without the password its
 * coming-soon page (the site's public/soon.html, put in front by its middleware.js), which asks for an email
 * address to tell when it opens. The page promises one email on opening day, then the address is deleted, so
 * the send below mails each address once and deletes it in the same step. An admin presses it on the site's
 * admin page, which also lists the addresses and can take one off for someone who asks. Nothing else reads
 * this table.
 */

/** Where the email sends people: the site, at the address it opens on. */
function siteUrl() {
  return (process.env.SITE_URL?.trim() || 'https://blipka.com').replace(/\/$/, '')
}

/** One address, one row: trimmed and lowercased. */
export function launchAddress(raw: string) {
  return raw.trim().toLowerCase()
}

/** On the list; already being on it is fine, and changes nothing. */
export async function joinLaunchList(email: string, now = Date.now()): Promise<void> {
  await db()
    .insert(launchList)
    .values({ email: launchAddress(email), createdAt: now })
    .onConflictDoNothing()
}

/** Everyone on it, the latest first: the admin page's list and its download. */
export async function listLaunchList(limit = 10_000) {
  return db().select().from(launchList).orderBy(desc(launchList.createdAt)).limit(limit)
}

/** Off the list, for someone who asked; false when the address wasn't on it. */
export async function leaveLaunchList(email: string): Promise<boolean> {
  const gone = await db()
    .delete(launchList)
    .where(eq(launchList.email, launchAddress(email)))
    .returning({ email: launchList.email })
  return gone.length > 0
}

/** The one email: Blipka is open. It says the address is gone, which it is once the send has gone through. */
export function launchEmail(): Omit<Mail, 'to'> {
  const url = siteUrl()
  const lines = [
    'You asked to hear when Blipka opened, so here it is: quick games you play in your browser, on a phone or a computer, and a new daily race every day. Season 1, Space Race, has begun.',
    'This is the one email we promised. Your address has been deleted from the list, so you won’t hear from us again unless you sign up on the site.',
  ]
  return {
    subject: 'Blipka is open',
    text: ['Blipka is open.', lines[0], `Play now: ${url}`, lines[1]].join('\n\n'),
    html: [
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14212b">',
      '<h1 style="font-size:24px;line-height:1.2;margin:0 0 12px">Blipka is open</h1>',
      `<p style="font-size:16px;line-height:1.5;margin:0 0 20px">${lines[0]}</p>`,
      `<p style="margin:0 0 24px"><a href="${url}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#2eb8a0;color:#04231c;font-size:16px;font-weight:bold;text-decoration:none">Play now</a></p>`,
      `<p style="font-size:13px;line-height:1.5;color:#5b6b77;margin:0">${lines[1]}</p>`,
      '</div>',
    ].join(''),
  }
}

/** The email as the list will get it, to an admin's own address, to see it first. */
export async function sendLaunchTest(to: string): Promise<void> {
  await sendMail({ ...launchEmail(), to })
}

let sending: Promise<unknown> | null = null

/**
 * The next batch, earliest signed up first: one call to Resend for up to BATCH_MAX (its free plan sends 100 a
 * day anyway), then those addresses are deleted. The admin page presses again for the rest. One send at a
 * time, so a second press can't mail the same batch twice.
 */
export async function sendLaunchBatch(): Promise<{ sent: number; left: number }> {
  if (sending) throw Object.assign(new Error('A send is already going. Refresh in a moment.'), { status: 409, code: 'BUSY' })
  const run = (async () => {
    const rows = await db()
      .select({ email: launchList.email })
      .from(launchList)
      .orderBy(asc(launchList.createdAt), asc(launchList.email))
      .limit(BATCH_MAX)
    if (rows.length) {
      const mail = launchEmail()
      await sendMailBatch(rows.map((row) => ({ ...mail, to: row.email })))
      const sent = rows.map((row) => row.email)
      // The emails have gone: a list that kept these would mail them twice on the next press.
      await dropSent(sent).catch(() => dropSent(sent))
    }
    const [left] = await db().select({ n: count() }).from(launchList)
    return { sent: rows.length, left: left?.n ?? 0 }
  })()
  sending = run
  try {
    return await run
  } finally {
    sending = null
  }
}

async function dropSent(emails: string[]) {
  try {
    await db().delete(launchList).where(inArray(launchList.email, emails))
  } catch (err) {
    console.error(`[launch list] ${emails.length} emails went but their addresses are still on the list:`, err)
    throw Object.assign(
      new Error('The emails went, but their addresses are still on the list: pressing again would send them twice.'),
      { status: 500, code: 'SENT_NOT_DELETED' },
    )
  }
}
