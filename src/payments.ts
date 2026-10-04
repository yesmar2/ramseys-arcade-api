import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { noteSubscription, settlePlusSession } from './plus.js'
import { grantPlus, SEASONS, type SeasonDef } from './seasons.js'

/*
 * Payments: a season's Pass+ (seasons.ts), bought once, and the Plus membership (plus.ts), monthly, both
 * through Stripe Checkout. Stripe's hosted page takes the
 * card, so no card ever touches this server or the site; this asks Stripe for a checkout, and Stripe tells
 * the webhook (and the site's return, as a backstop) when it's paid. Off until STRIPE_SECRET_KEY is set:
 * the site then shows Pass+ without a way to buy it.
 *
 * Settings: STRIPE_SECRET_KEY (sk_test_… on staging, sk_live_… live), STRIPE_WEBHOOK_SECRET (whsec_…, from
 * the webhook Stripe sends to /payments/stripe/webhook).
 */

const STRIPE = 'https://api.stripe.com/v1'

export function paymentsEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim())
}

function refusal(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

/** Stripe's form encoding, nested keys and all: { a: { b: 1 } } as a[b]=1. */
function form(params: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (typeof value === 'object') out.push(...form(value as Record<string, unknown>, name))
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
  }
  return out
}

export async function stripe<T>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) throw refusal('Payments aren’t set up yet', 503, 'PAYMENTS_OFF')
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: params ? form(params).join('&') : undefined,
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) {
    console.warn(`[payments] Stripe ${method} ${path}: ${res.status} ${body.error?.message ?? ''}`)
    throw refusal('The payment page couldn’t be opened', 502, 'PAYMENTS_FAILED')
  }
  return body
}

/** Where to send a buyer back to: the site that asked, if it's one this API serves; else the site's own. */
export function returnOrigin(req: Request): string {
  const asked = req.get('origin')?.replace(/\/$/, '') ?? ''
  const allowed = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim().replace(/\/$/, '')) ?? null
  if (asked && /^https?:\/\//.test(asked) && (!allowed || allowed.includes(asked))) return asked
  return process.env.FRONTEND_ORIGIN?.replace(/\/$/, '') || 'http://localhost:5173'
}

export type CheckoutSession = {
  id: string
  mode?: 'payment' | 'subscription' | 'setup'
  url: string | null
  payment_status: 'paid' | 'unpaid' | 'no_payment_required'
  amount_total: number | null
  currency: string | null
  client_reference_id: string | null
  metadata: Record<string, string> | null
}

/** A Stripe Checkout for a season's Pass+, for one account. Its page's address. */
export async function plusCheckout(def: SeasonDef, accountId: string, origin: string, email?: string | null): Promise<string> {
  if (!def.plus) throw refusal('That season has no Pass+', 404, 'NO_PLUS')
  const session = await stripe<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: accountId,
    customer_email: email || undefined,
    metadata: { accountId, season: def.id },
    payment_intent_data: { metadata: { accountId, season: def.id }, description: `Season ${def.id} Pass+ (${def.name})` },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: def.plus.currency,
          unit_amount: def.plus.price,
          product_data: {
            name: `Season ${def.id} Pass+ · ${def.name}`,
            description: 'The Pass+ row of the season pass: skins and looks, yours to keep. Looks only, never score.',
          },
        },
      },
    },
    success_url: `${origin}/season?plus=done&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/season?plus=cancelled`,
  })
  if (!session.url) throw refusal('The payment page couldn’t be opened', 502, 'PAYMENTS_FAILED')
  return session.url
}

/** A paid checkout's Pass+, given once: the webhook, or the buyer coming back, whichever is first. */
async function settleCheckout(session: CheckoutSession, accountId?: string): Promise<boolean> {
  const owner = session.metadata?.accountId ?? session.client_reference_id
  const seasonId = Number(session.metadata?.season)
  if (!owner || !Number.isInteger(seasonId) || !SEASONS.some((s) => s.id === seasonId)) return false
  if (accountId && owner !== accountId) throw refusal('That payment is another account’s', 403, 'NOT_YOURS')
  if (session.payment_status !== 'paid') return false
  await grantPlus(owner, seasonId, { source: 'stripe', ref: session.id, amount: session.amount_total, currency: session.currency })
  return true
}

/** The buyer back on the Season page: their checkout, if it's paid, gives Pass+ now. */
export async function confirmCheckout(sessionId: string, accountId: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw refusal('Not a checkout', 400, 'BAD_SESSION')
  const session = await stripe<CheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`)
  return settleCheckout(session, accountId)
}

/** Whether a webhook's body is Stripe's: its signature header against the webhook's secret, within five minutes. */
export function stripeSigned(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header) return false
  const parts = header.split(',').map((p) => p.split('=') as [string, string])
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest()
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const given = Buffer.from(v ?? '', 'hex')
      return given.length === expected.length && crypto.timingSafeEqual(given, expected)
    })
}

/** POST /payments/stripe/webhook, mounted with a raw body: a checkout paid gives its Pass+ or starts Plus; a subscription's changes move the plan. */
export async function stripeWebhook(req: Request, res: Response) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  const raw = req.body as Buffer
  if (!secret || !Buffer.isBuffer(raw) || !stripeSigned(raw, req.get('stripe-signature'), secret)) {
    res.status(400).json({ error: 'Not a Stripe event' })
    return
  }
  try {
    const event = JSON.parse(raw.toString('utf8')) as { type: string; data: { object: CheckoutSession } }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object
      if (session.mode === 'subscription') {
        const member = await settlePlusSession(session)
        if (member) console.log(`[payments] Plus from checkout ${session.id}`)
      } else {
        const given = await settleCheckout(session)
        if (given) console.log(`[payments] Pass+ from checkout ${session.id}`)
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.created') {
      await noteSubscription(event.data.object as unknown as Parameters<typeof noteSubscription>[0])
    }
    res.json({ received: true })
  } catch (err) {
    console.warn('[payments] webhook', err)
    // Stripe tries again later on anything but a 2xx.
    res.status(500).json({ error: 'Couldn’t take that event' })
  }
}
