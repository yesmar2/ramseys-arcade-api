import crypto from 'node:crypto'
import type { Request } from 'express'

/**
 * In-memory sliding-window limiter.
 *
 * Deliberately not in the database: the whole point is to answer before doing
 * any work, and a limiter that costs a round trip to Neon is a limiter that
 * makes a flood more expensive, not less. The cost is that the window is
 * per-instance and resets on deploy, which is the right trade for one Render
 * service — revisit it if this ever runs more than one.
 */
type Window = { hits: number[] }

const windows = new Map<string, Window>()

/** Bound the map so a flood of distinct keys cannot grow it without limit. */
const MAX_KEYS = 20_000

export type Limit = { limit: number; windowMs: number }

export type LimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number }

export function takeToken(key: string, { limit, windowMs }: Limit): LimitVerdict {
  const now = Date.now()
  const cutoff = now - windowMs

  let window = windows.get(key)
  if (!window) {
    if (windows.size >= MAX_KEYS) sweep(cutoff)
    window = { hits: [] }
    windows.set(key, window)
  }

  // Hits are appended in order, so the stale ones are always a prefix.
  let first = 0
  while (first < window.hits.length && window.hits[first]! <= cutoff) first += 1
  if (first > 0) window.hits.splice(0, first)

  if (window.hits.length >= limit) {
    const oldest = window.hits[0]!
    return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) }
  }

  window.hits.push(now)
  return { ok: true, remaining: limit - window.hits.length }
}

function sweep(cutoff: number) {
  for (const [key, window] of windows) {
    if (window.hits.length === 0 || window.hits[window.hits.length - 1]! <= cutoff) {
      windows.delete(key)
    }
  }
  // Still full of live keys: drop the oldest arbitrary slice rather than grow.
  if (windows.size >= MAX_KEYS) {
    let drop = Math.ceil(MAX_KEYS / 10)
    for (const key of windows.keys()) {
      windows.delete(key)
      if (--drop <= 0) break
    }
  }
}

/** Test seam — the window is process state, so a test needs a way to reset it. */
export function resetLimits() {
  windows.clear()
}

/**
 * Salted hash of the caller's address.
 *
 * Stored on scores so two runs can be tied together during an investigation
 * without the boards becoming a log of where people live. The salt lives in
 * the environment: rotate it and old hashes simply stop correlating.
 */
const IP_SALT = process.env.IP_HASH_SALT ?? 'skermix-dev-salt'

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

export function hashIp(ip: string): string {
  return crypto.createHmac('sha256', IP_SALT).update(ip).digest('base64url').slice(0, 22)
}
