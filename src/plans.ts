/**
 * What each plan allows.
 *
 * The split is participate / organize: everything that is playing, scoring,
 * ranking, or *joining* somebody else's event is free and stays free. What
 * costs money is running events for other people — which is also the only
 * part whose cost to us scales with use.
 *
 * One rule holds the model up: joining is never gated. A paying organiser
 * brings a roster of free players with them, so a paywall in front of an
 * invitee would tax the thing that grows the arcade.
 */

export type AccountPlan = 'free' | 'plus'

export type PlanLimits = {
  /** Private events running at once. */
  activeEvents: number
  /** Groups you own. */
  groups: number
  /** Roster size of a group you own. */
  groupMembers: number
  /** Ceiling on an event's player cap. Joining a bigger one is still free. */
  maxDraw: number
  doubleElimination: boolean
  /** A different game per bracket round. */
  multiGameRounds: boolean
}

/**
 * Free is deliberately one of each rather than none.
 *
 * Nobody buys a feature they have never used, and an arcade with no events in
 * it has nothing to show a visitor. One live event and one group is enough to
 * run a family bracket and find out it is good; the wall arrives at the second
 * one, which is exactly when the value has proved itself.
 */
export const PLAN_LIMITS: Record<AccountPlan, PlanLimits> = {
  free: {
    activeEvents: 1,
    groups: 1,
    groupMembers: 20,
    maxDraw: 8,
    doubleElimination: false,
    multiGameRounds: false,
  },
  plus: {
    activeEvents: 5,
    groups: 5,
    groupMembers: 100,
    maxDraw: 64,
    doubleElimination: true,
    multiGameRounds: true,
  },
}

export function planLimits(plan: AccountPlan | undefined | null): PlanLimits {
  return PLAN_LIMITS[plan === 'plus' ? 'plus' : 'free']
}

export function isPlus(plan: AccountPlan | undefined | null): boolean {
  return plan === 'plus'
}

/** Which allowance was hit, so the client can name it and offer the upgrade. */
export type PlanLimitKind =
  | 'activeEvents'
  | 'groups'
  | 'groupMembers'
  | 'maxDraw'
  | 'doubleElimination'
  | 'multiGameRounds'

export type PlanError = Error & {
  status: number
  code: 'PLAN_LIMIT'
  limit: PlanLimitKind
  plan: AccountPlan
  /** The allowance they were under, for a message that states the number. */
  allowed: number | boolean
}

/**
 * Refuse an action the plan does not cover.
 *
 * Always 402: the request was valid and the caller is who they say they are,
 * it just costs money. A 403 would read as "not allowed", which sends the
 * client looking for a permissions bug instead of an upgrade.
 */
export function planDenied(
  limit: PlanLimitKind,
  plan: AccountPlan,
  message: string,
): PlanError {
  return Object.assign(new Error(message), {
    status: 402,
    code: 'PLAN_LIMIT' as const,
    limit,
    plan,
    allowed: planLimits(plan)[limit],
  })
}

/**
 * The extra fields a plan refusal carries, for an error response.
 *
 * Returns nothing for any other error, so a route's error handler can spread
 * it unconditionally.
 */
export function planErrorFields(err: unknown): Record<string, unknown> {
  const e = err as Partial<PlanError>
  if (e?.code !== 'PLAN_LIMIT') return {}
  return { limit: e.limit, plan: e.plan, allowed: e.allowed }
}
