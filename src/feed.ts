import crypto from 'node:crypto'
import os from 'node:os'
import { and, eq, gt, inArray, lt, or, sql, type SQLWrapper } from 'drizzle-orm'
import { db, queryStats, type Db } from './db/client.js'
import { changeFeed, leases } from './db/schema.js'

/*
 * The API can run as more than one server (MULTI_INSTANCE=1). Each keeps its
 * own copy of the boards, the record books, the events, the tags and the
 * sessions in memory, which is what makes a request cheap, so a change one
 * server makes has to reach the others' copies. Every change a copy takes in
 * place is also written to the change feed, a table every server reads twice
 * a second, putting the others' changes into its own copy.
 *
 * A player's next request can land on another server than their write did,
 * before that server has read the feed. So the response to a write says
 * where it sits in the feed (X-Feed-Id), the app says it back for a few
 * seconds after (X-Feed-After), and a server that hasn't read that far reads
 * the feed before it answers. A player always sees what they just did;
 * anyone else's change is at most half a second behind.
 *
 * Jobs only one server should do (the sweep, pruning the feed, the checks at
 * boot), and changes to an event that must be made one at a time, go behind
 * a lease: a row saying which server holds it, and until when.
 *
 * With one server, the default, none of this runs: nothing is written to the
 * feed, nothing reads it, and a lease is always held.
 */
export const MULTI_INSTANCE = process.env.MULTI_INSTANCE === '1'

/** This process: a restart is a new server, whose copies were read from the tables after the old one's changes. */
export const INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID?.trim() || os.hostname()}-${process.pid}-${crypto
  .randomBytes(3)
  .toString('hex')}`

const POLL_MS = 500
const POLL_LIMIT = 1_000
/** A change numbered but not yet readable is waited for this long, then taken for one rolled back. */
const GAP_WAIT_MS = 30_000
/** How long a change stays in the feed: far longer than any server takes to read it. */
const KEEP_MS = 10 * 60_000

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Handler = (payload: never) => void | Promise<void>

const handlers = new Map<string, Handler>()

/** What this server does with another server's change of a kind. */
export function onChange<P>(kind: string, handler: (payload: P) => void | Promise<void>) {
  handlers.set(kind, handler as Handler)
}

/** The highest feed number read, the numbers below it not readable yet, and this server's own changes (kept a minute). */
let maxSeen = 0
const gaps = new Map<number, number>()
const own = new Map<number, number>()
let started = false

/**
 * Write a change to the feed; its number, or null with one server. Inside a
 * transaction (tx), it lands with the change itself, and the caller says so
 * to its request (noteFeedId) once that commits.
 */
export async function publish(kind: string, payload: unknown, tx?: Tx): Promise<number | null> {
  if (!MULTI_INSTANCE) return null
  const [row] = await (tx ?? db())
    .insert(changeFeed)
    .values({ at: Date.now(), instance: INSTANCE_ID, kind, payload })
    .returning({ id: changeFeed.id })
  const id = Number(row!.id)
  own.set(id, Date.now())
  if (!tx) noteFeedId(id)
  return id
}

/**
 * Insert a row and its change to the feed in one statement, so neither lands
 * without the other. With one server, just the row.
 */
export async function insertWithFeed(
  insert: SQLWrapper & PromiseLike<unknown>,
  kind: string,
  payload: unknown,
): Promise<void> {
  if (!MULTI_INSTANCE) {
    await insert
    return
  }
  const rows = await db().execute<{ id: string | number }>(
    // Drizzle puts the insert in its brackets when it's part of another statement.
    sql`with written as ${insert} insert into ${changeFeed} ("at", "instance", "kind", "payload") values (${Date.now()}, ${INSTANCE_ID}, ${kind}, ${JSON.stringify(payload)}::jsonb) returning "id"`,
  )
  const id = Number(rows[0]?.id)
  if (!id) return
  own.set(id, Date.now())
  noteFeedId(id)
}

/*
 * A table rewritten wholesale (a ban's purge, a rename, a script's reseed):
 * every other server reads its copy of it again. Each module says what reading
 * one again means for it.
 */
const rewriteHandlers = new Map<string, () => void>()

export function onRewrite(table: 'scores' | 'records' | 'events' | 'claims' | 'groups' | 'site-records', fn: () => void) {
  rewriteHandlers.set(table, fn)
}

onChange<{ tables?: string[] }>('rewritten', ({ tables }) => {
  for (const table of tables ?? []) rewriteHandlers.get(table)?.()
})

/**
 * Tell the other servers tables were rewritten; logged, never thrown, since
 * the write it follows is done. A script (force) tells them even though it
 * isn't a server itself.
 */
export async function announceRewrite(
  tables: ('scores' | 'records' | 'events' | 'claims' | 'groups' | 'site-records')[],
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!MULTI_INSTANCE && !opts.force) return
  try {
    const [row] = await db()
      .insert(changeFeed)
      .values({ at: Date.now(), instance: INSTANCE_ID, kind: 'rewritten', payload: { tables } })
      .returning({ id: changeFeed.id })
    const id = Number(row!.id)
    own.set(id, Date.now())
    noteFeedId(id)
  } catch (err) {
    console.warn(`[feed] announcing ${tables.join(', ')} rewritten failed:`, err)
  }
}

/** A change other servers must hear of whose own write is already done: logged, never thrown. */
export async function announce(kind: string, payload: unknown = {}): Promise<void> {
  try {
    await publish(kind, payload)
  } catch (err) {
    console.warn(`[feed] announcing ${kind} failed:`, err)
  }
}

/** Tell the request under way the feed number of a change it made, for its X-Feed-Id. */
export function noteFeedId(id: number | null | undefined) {
  if (!id) return
  const stats = queryStats.getStore()
  if (stats && (stats.feedId ?? 0) < id) stats.feedId = id
}

async function pollOnce() {
  const waiting = [...gaps.keys()]
  const rows = await db()
    .select()
    .from(changeFeed)
    .where(waiting.length ? or(gt(changeFeed.id, maxSeen), inArray(changeFeed.id, waiting)) : gt(changeFeed.id, maxSeen))
    .orderBy(changeFeed.id)
    .limit(POLL_LIMIT)
  const now = Date.now()
  for (const row of rows) {
    const id = Number(row.id)
    if (id > maxSeen) {
      // Numbers skipped are changes still being written, or rolled back: looked for again.
      for (let skipped = Math.max(maxSeen + 1, id - 1_000); skipped < id; skipped++) gaps.set(skipped, now)
      maxSeen = id
    } else if (!gaps.delete(id)) {
      continue
    }
    if (row.instance === INSTANCE_ID) continue
    const handler = handlers.get(row.kind)
    if (!handler) continue
    try {
      await handler(row.payload as never)
    } catch (err) {
      console.warn(`[feed] applying ${row.kind} #${id} failed:`, err)
    }
  }
  for (const [id, at] of gaps) if (now - at > GAP_WAIT_MS) gaps.delete(id)
  for (const [id, at] of own) if (now - at > 60_000) own.delete(id)
}

let polling: Promise<void> | null = null
let queued: Promise<void> | null = null

/** A read of the feed that begins from now: the one under way began too soon, so this one follows it. */
export function pollNow(): Promise<void> {
  if (!MULTI_INSTANCE || !started) return Promise.resolve()
  if (!polling) {
    polling = pollOnce().finally(() => {
      polling = null
    })
    return polling
  }
  queued ??= polling
    .catch(() => {})
    .then(() => {
      queued = null
      return pollNow()
    })
  return queued
}

function applied(id: number): boolean {
  if (own.has(id)) return true
  if (id > maxSeen) return false
  for (const gap of gaps.keys()) if (gap <= id) return false
  return true
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Hold a request until this server has read the feed as far as a change the
 * caller made elsewhere. A read begun after the request arrived sees every
 * change the caller could have heard of, so one such read is enough; two
 * seconds at most, and the request goes ahead regardless.
 */
export async function waitFor(id: number, timeoutMs = 2_000) {
  if (!MULTI_INSTANCE || !started || !(id > 0) || applied(id)) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await Promise.race([pollNow(), sleep(deadline - Date.now())])
      if (maxSeen >= id) return
    } catch (err) {
      console.warn('[feed] reading the feed failed:', err)
      await sleep(Math.min(200, Math.max(0, deadline - Date.now())))
    }
  }
}

/** Start reading the feed: before the first copy is read, so nothing written meanwhile is missed. */
export async function startFeed() {
  if (!MULTI_INSTANCE || started) return
  const [top] = await db()
    .select({ id: sql<number>`coalesce(max(${changeFeed.id}), 0)::float8` })
    .from(changeFeed)
  maxSeen = Number(top?.id ?? 0)
  // A change numbered just before now may still be being written: looked for like any gap.
  const recent = await db()
    .select({ id: changeFeed.id })
    .from(changeFeed)
    .where(gt(changeFeed.id, Math.max(0, maxSeen - 200)))
  const there = new Set(recent.map((r) => Number(r.id)))
  const now = Date.now()
  for (let id = Math.max(1, maxSeen - 200); id <= maxSeen; id++) if (!there.has(id)) gaps.set(id, now)
  started = true
  // Told to stop (a deploy, a scale-down): let go of any lease, so another server sweeps without waiting it out.
  const letGo = () => {
    setTimeout(() => process.exit(0), 2_000).unref()
    void db()
      .delete(leases)
      .where(eq(leases.holder, INSTANCE_ID))
      .catch(() => {})
      .finally(() => process.exit(0))
  }
  process.once('SIGTERM', letGo)
  process.once('SIGINT', letGo)
  const tick = () => {
    pollNow()
      .catch((err: unknown) => console.warn('[feed] reading the feed failed:', err))
      .finally(() => setTimeout(tick, POLL_MS).unref())
  }
  setTimeout(tick, POLL_MS).unref()
  console.log(`[feed] ${INSTANCE_ID} reading the change feed from #${maxSeen}`)
}

/** Drop changes every server has long since read, and leases long run out. For the sweep's holder. */
export async function pruneFeed(now = Date.now()) {
  if (!MULTI_INSTANCE) return
  await db().delete(changeFeed).where(lt(changeFeed.at, now - KEEP_MS))
  await db().delete(leases).where(lt(leases.until, now - 60 * 60_000))
}

/**
 * Take or keep a lease for ttlMs: true if this server holds it now. Always
 * true with one server.
 */
export async function takeLease(name: string, ttlMs: number): Promise<boolean> {
  if (!MULTI_INSTANCE) return true
  const now = Date.now()
  const rows = await db()
    .insert(leases)
    .values({ name, holder: INSTANCE_ID, until: now + ttlMs })
    .onConflictDoUpdate({
      target: leases.name,
      set: { holder: INSTANCE_ID, until: now + ttlMs },
      setWhere: or(eq(leases.holder, INSTANCE_ID), lt(leases.until, now)),
    })
    .returning({ holder: leases.holder })
  return rows.length > 0
}

async function dropLease(name: string) {
  await db()
    .delete(leases)
    .where(and(eq(leases.name, name), eq(leases.holder, INSTANCE_ID)))
}

/** Within this server, one holder of a lease at a time: the lease itself only tells servers apart. */
const localHolds = new Map<string, Promise<unknown>>()

/**
 * Run fn as the only holder of a lease across every server, waiting up to
 * waitMs for it. With one server it simply runs.
 */
export async function withLease<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  if (!MULTI_INSTANCE) return fn()
  const ttlMs = opts.ttlMs ?? 15_000
  const waitMs = opts.waitMs ?? 10_000
  const before = localHolds.get(name) ?? Promise.resolve()
  const mine = before.catch(() => {}).then(async () => {
    const deadline = Date.now() + waitMs
    let delay = 10
    while (!(await takeLease(name, ttlMs))) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error('Busy right now, try again'), { status: 503, code: 'BUSY' })
      }
      await sleep(delay)
      delay = Math.min(delay * 2, 200)
    }
    try {
      return await fn()
    } finally {
      await dropLease(name).catch((err: unknown) => console.warn(`[feed] dropping lease ${name} failed:`, err))
    }
  })
  localHolds.set(name, mine)
  try {
    return await mine
  } finally {
    if (localHolds.get(name) === mine) localHolds.delete(name)
  }
}
