import { eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { accounts, memberships, prizesOwned } from './db/schema.js'
import { stripe, type CheckoutSession } from './payments.js'
import { prizeById } from './prizes.js'
import { seasonNow, syncSeason } from './seasons.js'
import { boardDateKey } from './store.js'

/*
 * Plus, the membership: what it's always been (more events and groups to host, plans.ts); since Ramsey
 * picked it on 2026-10-03, every season's Pass+ while you're a member (seasons.ts plusOf); and since
 * 2026-10-04, the Dailies + Seasons membership: every past day of every daily (the site opens the archive,
 * archive.ts keeps those runs off the boards), a members' look each month, and new games first
 * (earlyAccess.ts). Paid monthly
 * through a Stripe subscription; Stripe's own page takes the card, and its customer portal is where a member
 * changes the card or cancels. `accounts.plan` is what everything else reads; the subscription's state, sent
 * by Stripe's webhook, moves it.
 */

/**
 * Plus's price: $2.99 a month, the same as a season's Pass+ (Ramsey, 2026-10-04). Joining for a month gives
 * the season's Pass+ up to your level for good, so a month must never cost less than Pass+ itself.
 */
export const PLUS_PRICE = { amount: 299, currency: 'usd', interval: 'month' } as const

/**
 * The members' looks: each month, every Plus member gets that month's (Ramsey's pick, 2026-10-04: the
 * Dailies + Seasons membership), kept for good. Months are the boards' (America/New_York), YYYYMM. The
 * arcade's opening months also give Founding Member.
 */
export const MEMBERS_LOOKS: readonly { month: number; id: string; name: string; what: string }[] = [
  { month: 202610, id: 't-founder', name: 'Founding Member', what: 'Title' },
  { month: 202611, id: 't-founder', name: 'Founding Member', what: 'Title' },
  { month: 202611, id: 'nm-prism', name: 'Prism', what: 'Name style' },
  { month: 202612, id: 't-founder', name: 'Founding Member', what: 'Title' },
  { month: 202612, id: 'cd-snowglobe', name: 'Snow globe', what: 'Card theme' },
  { month: 202701, id: 'cf-streamers', name: 'Streamers', what: 'Confetti' },
]

export function monthOf(now = Date.now()): number {
  return Math.floor(boardDateKey(now) / 100)
}

/** This month's members' looks, the ones this release can give. */
export function membersLooks(now = Date.now()) {
  const month = monthOf(now)
  return MEMBERS_LOOKS.filter((l) => l.month === month && prizeById(l.id) != null)
}

/** A member's looks for this month, given if they're on Plus: once, however often it's asked. */
export async function giveMembersLooks(accountId: string, plan: string | null | undefined, now = Date.now()) {
  if (plan !== 'plus') return
  for (const look of membersLooks(now)) {
    await db().insert(prizesOwned).values({ accountId, prizeId: look.id, price: 0, at: now }).onConflictDoNothing()
  }
}

function refusal(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

type Subscription = {
  id: string
  customer: string
  status: string
  cancel_at_period_end: boolean
  current_period_end?: number
  items?: { data?: { current_period_end?: number }[] }
  metadata: Record<string, string> | null
}

/** Stripe's states that still count as a member: paying, trying it, or a card that failed and is being retried. */
const MEMBER_STATES = new Set(['active', 'trialing', 'past_due'])

export type PlusState = { plan: 'free' | 'plus'; status: string | null; renewsAt: number | null; cancelsAtEnd: boolean; source: string | null }

export async function plusState(accountId: string): Promise<PlusState> {
  const [account] = await db().select({ plan: accounts.plan }).from(accounts).where(eq(accounts.id, accountId)).limit(1)
  const [m] = await db().select().from(memberships).where(eq(memberships.accountId, accountId)).limit(1)
  return {
    plan: account?.plan === 'plus' ? 'plus' : 'free',
    status: m?.status ?? null,
    renewsAt: m?.renewsAt ?? null,
    cancelsAtEnd: m?.cancelsAtEnd ?? false,
    source: m?.source ?? null,
  }
}

/** The plan, and the season's Pass+ rewards up to their level the moment they become a member. */
async function setPlan(accountId: string, plus: boolean, now = Date.now()) {
  await db().update(accounts).set({ plan: plus ? 'plus' : 'free' }).where(eq(accounts.id, accountId))
  if (!plus) return
  await giveMembersLooks(accountId, 'plus', now)
  const season = await seasonNow(now)
  if (season?.status === 'live') await syncSeason(accountId, now, { catchUp: true, announce: false }).catch(() => null)
}

async function keepMembership(
  accountId: string,
  row: { source: string; customer?: string | null; subscription?: string | null; status: string; renewsAt?: number | null; cancelsAtEnd?: boolean },
  now = Date.now(),
) {
  const values = {
    accountId,
    source: row.source,
    customer: row.customer ?? null,
    subscription: row.subscription ?? null,
    status: row.status,
    renewsAt: row.renewsAt ?? null,
    cancelsAtEnd: row.cancelsAtEnd ?? false,
    updatedAt: now,
  }
  await db().insert(memberships).values(values).onConflictDoUpdate({ target: memberships.accountId, set: values })
}

/** A subscription as Stripe has it now: the membership and the plan follow it. */
export async function noteSubscription(sub: Subscription, accountIdHint?: string | null) {
  let accountId = sub.metadata?.accountId ?? accountIdHint ?? null
  if (!accountId) {
    const [m] = await db().select({ accountId: memberships.accountId }).from(memberships).where(eq(memberships.subscription, sub.id)).limit(1)
    accountId = m?.accountId ?? null
  }
  if (!accountId) return false
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null
  const member = MEMBER_STATES.has(sub.status)
  await keepMembership(accountId, {
    source: 'stripe',
    customer: sub.customer,
    subscription: sub.id,
    status: sub.status,
    renewsAt: periodEnd ? periodEnd * 1000 : null,
    cancelsAtEnd: sub.cancel_at_period_end,
  })
  await setPlan(accountId, member)
  return member
}

/** A Stripe Checkout for a Plus membership, monthly, for one account. Its page's address. */
export async function plusCheckout(accountId: string, origin: string, email?: string | null): Promise<string> {
  const state = await plusState(accountId)
  if (state.plan === 'plus') throw refusal('You’re a Plus member already', 409, 'ALREADY_PLUS')
  const session = await stripe<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: accountId,
    customer_email: email || undefined,
    metadata: { accountId, kind: 'plus' },
    subscription_data: { metadata: { accountId } },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: PLUS_PRICE.currency,
          unit_amount: PLUS_PRICE.amount,
          recurring: { interval: PLUS_PRICE.interval },
          product_data: {
            name: 'Blipka Plus',
            description:
              'Every past day of every daily, every season’s Pass+, a members’ look each month, brand-new games before launch, and more events and groups to host. Playing stays free.',
          },
        },
      },
    },
    success_url: `${origin}/plus?joined=done&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/plus?joined=cancelled`,
  })
  if (!session.url) throw refusal('The payment page couldn’t be opened', 502, 'PAYMENTS_FAILED')
  return session.url
}

/** A finished Plus checkout (the webhook's, or the buyer back on the Plus page): its subscription, noted. */
export async function settlePlusSession(session: CheckoutSession & { subscription?: string | Subscription | null }, accountId?: string) {
  const owner = session.metadata?.accountId ?? session.client_reference_id
  if (!owner) return false
  if (accountId && owner !== accountId) throw refusal('That payment is another account’s', 403, 'NOT_YOURS')
  const sub = typeof session.subscription === 'string' ? await stripe<Subscription>('GET', `/subscriptions/${encodeURIComponent(session.subscription)}`) : session.subscription
  if (!sub) return false
  return noteSubscription(sub, owner)
}

/** Back from Stripe on the Plus page: the checkout's subscription, if it's going, makes them a member now. */
export async function confirmPlus(sessionId: string, accountId: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw refusal('Not a checkout', 400, 'BAD_SESSION')
  const session = await stripe<CheckoutSession & { subscription?: string | null }>('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`)
  return settlePlusSession(session, accountId)
}

/** Stripe's customer portal for a member: change the card, see receipts, cancel. Its page's address. */
export async function plusPortal(accountId: string, origin: string): Promise<string> {
  const [m] = await db().select({ customer: memberships.customer }).from(memberships).where(eq(memberships.accountId, accountId)).limit(1)
  if (!m?.customer) throw refusal('There’s no Plus membership to manage', 404, 'NO_MEMBERSHIP')
  const portal = await stripe<{ url: string }>('POST', '/billing_portal/sessions', { customer: m.customer, return_url: `${origin}/plus` })
  return portal.url
}

/** Plus from an admin, or taken back: to try it without paying. A paying member's is theirs to cancel, not taken. */
export async function grantPlusMembership(accountId: string, on: boolean, now = Date.now()) {
  const [m] = await db().select({ source: memberships.source }).from(memberships).where(eq(memberships.accountId, accountId)).limit(1)
  if (m?.source === 'stripe') throw refusal('They pay for Plus: it’s cancelled from their membership, not here', 409, 'PAID_MEMBER')
  if (on) await keepMembership(accountId, { source: 'grant', status: 'active' }, now)
  else await db().delete(memberships).where(eq(memberships.accountId, accountId))
  await setPlan(accountId, on, now)
}
