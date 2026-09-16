/**
 * Send a real push to a player's registered devices, for testing delivery.
 *
 *   npm run push:test -- DAD
 *   npm run push:test -- DAD --raw
 *
 * The default goes through `sendPush`, so it proves the path the arcade
 * actually uses — including the guardrails, which will refuse the send during
 * quiet hours or over the daily cap. That refusal is the guardrail working;
 * `--raw` skips the policy layer to prove the transport on its own.
 */

import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import { db } from './db/client.js'
import { pushSubscriptions } from './db/schema.js'
import { getClaim } from './names.js'
import { sendPush } from './push.js'

const OUTCOMES: Record<string, string> = {
  sent: 'Delivered to the push service. It should appear on the device.',
  'not-configured': 'VAPID keys are missing from .env.',
  'not-pushable': 'That kind is inbox-only and can never be pushed.',
  'no-devices': 'Nobody has turned match alerts on for this account yet.',
  'quiet-hours': 'Held: it is between 22:00 and 08:00 on the device.',
  capped: 'Held: this account already had its 2 pushes today.',
  duplicate: 'Held: same match transition already pushed today.',
}

async function main() {
  const args = process.argv.slice(2)
  const raw = args.includes('--raw')
  const name = args.find((a) => !a.startsWith('--'))?.toUpperCase()

  if (!name) {
    console.error('Usage: npm run push:test -- <GAMERTAG> [--raw]')
    process.exit(1)
  }

  const claim = await getClaim(name)
  if (!claim?.accountId) {
    console.error(`No account owns the tag ${name}.`)
    process.exit(1)
  }

  const devices = await db()
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.accountId, claim.accountId))

  console.log(`${name} -> account ${claim.accountId}`)
  console.log(`devices registered: ${devices.length}`)
  for (const d of devices) {
    console.log(`  ${new URL(d.endpoint).host}  tz=${d.timeZone ?? 'unset'}`)
  }
  if (devices.length === 0) {
    console.log('\nTurn on "Match alerts" in the notification panel first.')
    process.exit(0)
  }

  const payload = {
    title: 'Test alert',
    body: 'If you can see this, match alerts are working.',
    href: '#/tournaments',
    kind: 'match-open',
  }

  if (raw) {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
    if (!publicKey || !privateKey) {
      console.error('\nVAPID keys missing from .env.')
      process.exit(1)
    }
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT?.trim() || 'mailto:hello@skermix.com',
      publicKey,
      privateKey,
    )
    for (const d of devices) {
      try {
        await webpush.sendNotification(
          { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
          JSON.stringify(payload),
        )
        console.log(`\nraw send -> ok (${new URL(d.endpoint).host})`)
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        console.log(`\nraw send -> FAILED status=${status ?? '?'}`)
        console.log(`  ${(err as Error).message}`)
      }
    }
    process.exit(0)
  }

  const outcome = await sendPush(claim.accountId, {
    kind: 'match-open',
    title: payload.title,
    body: payload.body,
    href: payload.href,
    dedupeKey: `test:${Date.now()}`,
  })

  console.log(`\noutcome: ${outcome}`)
  console.log(OUTCOMES[outcome] ?? '')
  if (outcome !== 'sent') console.log('Re-run with --raw to bypass the policy layer.')
  process.exit(0)
}

void main()
