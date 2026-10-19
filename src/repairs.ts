import { and, asc, eq, gt, gte, inArray, like, notInArray, or, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { appMeta, leaderboardScores, notifications, recordScores, tournaments } from './db/schema.js'
import type { NotificationMeta } from './notifications.js'
import {
  courseOfPastId,
  courseOfRecord,
  coursePastHref,
  courseRecordId,
  courseWinBackHref,
  invalidateRecordHistoryCache,
  ASTEROIDS_WAVE_BOOKS,
  SCORE_STREAK_THRESHOLDS,
  SNAKE_LENGTH_BOOKS,
  THRESHOLD_STREAK_ID,
} from './records.js'
import { seedScoreCap, TIME_SCORE_BASE, TIME_SCORED_GAMES } from './scoreLimits.js'
import { filterByPeriod, isDeviceType, resolveGameSlug, type GameSlug, type LeaderboardEntry, type Period } from './store.js'
import { ordinal } from './words.js'

/**
 * One-time fixes to data that is already in the database, run at boot and
 * recorded in app_meta so each runs once per environment. Unlike the seed
 * revision these are narrow and meant for production too: they remove or
 * correct rows that could never have been real.
 */
type Repair = {
  id: string
  run: () => Promise<string>
}

const REPAIRS: Repair[] = [
  {
    // The world seed jittered elite time-scored runs above the base, so the
    // Find the Bug and Spotter boards were led by clears in negative time.
    id: '2026-09-21-impossible-times',
    run: async () => {
      const gone = await db()
        .delete(leaderboardScores)
        .where(
          and(
            inArray(leaderboardScores.game, [...TIME_SCORED_GAMES]),
            gte(leaderboardScores.score, TIME_SCORE_BASE),
          ),
        )
        .returning({ id: leaderboardScores.id })
      return `removed ${gone.length} time-scored rows at or above the base`
    },
  },
  {
    // The same jitter left seeded runs just under the base: one-second sweeps
    // of Find the Bug. Only sample rows go; a real player's time stays.
    id: '2026-09-21-seeded-superhuman-times',
    run: async () => {
      let removed = 0
      for (const game of TIME_SCORED_GAMES) {
        // A game time-scored since (Marble Run and the racing dailies) has no sample band to be above: Infinity,
        // which a fresh database refuses as a number, stopping every repair after this one.
        if (!Number.isFinite(seedScoreCap(game))) continue
        const gone = await db()
          .delete(leaderboardScores)
          .where(
            and(
              eq(leaderboardScores.game, game),
              like(leaderboardScores.id, 'seed-lb-%'),
              gt(leaderboardScores.score, seedScoreCap(game)),
            ),
          )
          .returning({ id: leaderboardScores.id })
        removed += gone.length
      }
      return `removed ${removed} seeded time-scored rows above their band`
    },
  },
  {
    // Events and notices saved before rank was put in plain words still said
    // their points. Only the old default lines change; a host's own blurb stays.
    id: '2026-09-29-plain-rank-copy',
    run: async () => {
      const events = await db()
        .update(tournaments)
        .set({
          data: sql`jsonb_set(${tournaments.data}, '{blurb}', to_jsonb(replace(replace(${tournaments.data}->>'blurb',
            'Place points across games — highest total wins.', 'Every game counts — best all-round wins.'),
            'Places earn points — highest total wins.', 'Play all three; best all-round wins.')))`,
        })
        .where(sql`${tournaments.data}->>'blurb' like '%highest total wins.%'`)
        .returning({ id: tournaments.id })
      // A trophy notice: "412 pts. The bronze medal…" -> "The bronze medal…"
      const trophies = await db()
        .update(notifications)
        .set({ body: sql`regexp_replace(${notifications.body}, '^[0-9,]+ pts?[.] ', '')` })
        .where(and(eq(notifications.kind, 'trophy'), sql`${notifications.body} ~ '^[0-9,]+ pts?[.] '`))
        .returning({ id: notifications.id })
      // An all-round event's result: "212 pts, out of 12 players. SAM won with 350 pts." -> "4th of 12 players. SAM won."
      const old = await db()
        .select({ id: notifications.id, body: notifications.body, meta: notifications.meta })
        .from(notifications)
        .where(and(eq(notifications.kind, 'event-result'), sql`${notifications.body} ~ '^[0-9,]+ pts?, out of '`))
      const reworded: { id: string; body: string }[] = []
      for (const n of old) {
        const m = /^[0-9,]+ pts?, out of (\d+ players?)\. (.+) won with [0-9,]+ pts?\.$/.exec(n.body ?? '')
        const place = (n.meta as { place?: number } | null)?.place
        if (m && place) reworded.push({ id: n.id, body: `${ordinal(place)} of ${m[1]}. ${m[2]} won.` })
      }
      for (let i = 0; i < reworded.length; i += 10) {
        await Promise.all(
          reworded
            .slice(i, i + 10)
            .map((n) => db().update(notifications).set({ body: n.body }).where(eq(notifications.id, n.id))),
        )
      }
      return `reworded ${events.length} event blurbs, ${trophies.length} trophy notices, ${reworded.length} event results`
    },
  },
  {
    // A daily's track, hole and day records left the record books (records.ts bookRecordDefs), so a note that
    // someone took one, which led to its page there and to today's play, leads to the course's row on its
    // game's Past tab now, onto the course itself only where a lap there can win it back, and names its
    // record for the inbox. Notes already sent to their row (the first go at this) are named too.
    id: '2026-09-29-course-record-notes',
    run: async () => {
      const rows = await db()
        .select({ id: notifications.id, href: notifications.href, meta: notifications.meta })
        .from(notifications)
        .where(
          and(
            eq(notifications.kind, 'record-lost'),
            or(like(notifications.href, '%/records/%'), like(notifications.href, '/games/%/past#course-%')),
          ),
        )
      let moved = 0
      for (const row of rows) {
        const book = /^#?\/records\/([a-z]+)\/([a-z]+-\d+)(?:\/|$)/.exec(row.href ?? '')
        const past = /^\/games\/([a-z]+)\/past#course-([\d-]+)$/.exec(row.href ?? '')
        const game = resolveGameSlug((book ?? past)?.[1] ?? '')
        if (!game) continue
        const n = book ? courseOfRecord(game, book[2]!) : courseOfPastId(game, past![2]!)
        const href = n != null ? coursePastHref(game, n) : null
        const recordId = n != null ? courseRecordId(game, n) : null
        if (n == null || !href || !recordId) continue
        const { playHref: _today, ...meta } = (row.meta ?? {}) as NotificationMeta
        const playHref = courseWinBackHref(game, n)
        await db()
          .update(notifications)
          .set({ href, meta: { ...meta, recordId, ...(playHref ? { playHref } : {}) } })
          .where(eq(notifications.id, row.id))
        moved++
      }
      return `sent ${moved} of ${rows.length} record notes to their course`
    },
  },
  {
    // Frenzy's "Scores over … in a row" line went from 3,000 to 10,000 (records.ts SCORE_STREAK_THRESHOLDS), and
    // the book's streaks were counted at the old one. They're counted again from the runs, as the API counts
    // them after each run (updateCrossRunStreakRecords): two or more in a row at the line, kept where the
    // streak beat the player's own best for the day, the week, the month or all time when it was run.
    id: '2026-10-11-frenzy-streak-10000',
    run: async () => {
      const { line, gone, kept } = await recountStreakBook('frenzy')
      invalidateRecordHistoryCache()
      return `counted Frenzy's streaks again at ${line.toLocaleString()}: ${gone} rows out, ${kept} in`
    },
  },
  {
    // The other games' "Scores over … in a row" lines went to about the score a quarter of runs reach (records.ts
    // SCORE_STREAK_THRESHOLDS, Ramsey's "yes, all of it", 2026-10-13), so their books are counted again at them.
    // Asteroids' wave books and Snake's length books were trimmed to every fifth wave and to 30, 50, 75 and 100
    // (ASTEROIDS_WAVE_BOOKS, SNAKE_LENGTH_BOOKS): the retired books' rows go.
    id: '2026-10-13-record-book-lines',
    run: async () => {
      const games = ['stacker', 'patriot', 'snake', 'pop', 'asteroids', 'pellets', 'crumbtrail', 'bop', 'putt', 'barrage', 'pileup'] as const
      const counted: string[] = []
      for (const game of games) {
        const { line, gone, kept } = await recountStreakBook(game)
        counted.push(`${game} at ${line.toLocaleString()} ${gone}→${kept}`)
      }
      const retired = await db()
        .delete(recordScores)
        .where(
          or(
            and(
              eq(recordScores.game, 'asteroids'),
              like(recordScores.recordId, 'wave-time-%'),
              notInArray(recordScores.recordId, ASTEROIDS_WAVE_BOOKS.map((wave) => `wave-time-${wave}`)),
            ),
            and(
              eq(recordScores.game, 'snake'),
              like(recordScores.recordId, 'fastest-length-%'),
              notInArray(recordScores.recordId, SNAKE_LENGTH_BOOKS.map((length) => `fastest-length-${length}`)),
            ),
          ),
        )
        .returning({ id: recordScores.id })
      invalidateRecordHistoryCache()
      return `counted the streak books again (${counted.join(', ')}); ${retired.length} rows of retired wave and length books gone`
    },
  },
  {
    // High Rise's "Scores over … in a row" line went from 25 to 80 (records.ts SCORE_STREAK_THRESHOLDS, Ramsey,
    // 2026-10-19), so its book is counted again at it.
    id: '2026-10-19-high-rise-streak-80',
    run: async () => {
      const { line, gone, kept } = await recountStreakBook('stacker')
      invalidateRecordHistoryCache()
      return `counted High Rise's streaks again at ${line.toLocaleString()}: ${gone} rows out, ${kept} in`
    },
  },
]

/**
 * A game's "Scores over … in a row" book counted again from its runs at its line now (records.ts
 * SCORE_STREAK_THRESHOLDS), as the API counts it after each run (updateCrossRunStreakRecords): two or more in a
 * row at the line, kept where the streak beat the player's own best for the day, the week, the month or all time
 * when it was run. The book's rows are replaced in one go.
 */
async function recountStreakBook(game: GameSlug): Promise<{ line: number; gone: number; kept: number }> {
  const line = SCORE_STREAK_THRESHOLDS[game]
  const runs = await db()
    .select({
      name: leaderboardScores.name,
      score: leaderboardScores.score,
      at: leaderboardScores.at,
      device: leaderboardScores.device,
    })
    .from(leaderboardScores)
    .where(eq(leaderboardScores.game, game))
    .orderBy(asc(leaderboardScores.at))
  const periods: Period[] = ['all', 'daily', 'weekly', 'monthly']
  const players = new Map<string, { streak: number; kept: LeaderboardEntry[] }>()
  const rows: (typeof recordScores.$inferInsert)[] = []
  for (const run of runs) {
    const p = players.get(run.name) ?? { streak: 0, kept: [] }
    players.set(run.name, p)
    p.streak = run.score >= line ? p.streak + 1 : 0
    if (p.streak < 2) continue
    const beats = (period: Period) => filterByPeriod(p.kept, period, run.at).every((e) => p.streak > e.score)
    if (!periods.some(beats)) continue
    const entry: LeaderboardEntry = {
      id: `${run.at}-${Math.random().toString(36).slice(2, 8)}`,
      name: run.name,
      score: p.streak,
      at: run.at,
      device: isDeviceType(run.device) ? run.device : 'desktop',
    }
    p.kept.push(entry)
    rows.push({ ...entry, game, recordId: THRESHOLD_STREAK_ID })
  }
  const gone = await db().transaction(async (tx) => {
    const old = await tx
      .delete(recordScores)
      .where(and(eq(recordScores.game, game), eq(recordScores.recordId, THRESHOLD_STREAK_ID)))
      .returning({ id: recordScores.id })
    for (let i = 0; i < rows.length; i += 250) await tx.insert(recordScores).values(rows.slice(i, i + 250))
    return old.length
  })
  return { line, gone, kept: rows.length }
}

export async function applyDataRepairs(): Promise<void> {
  for (const repair of REPAIRS) {
    const key = `repair:${repair.id}`
    const done = await db().select().from(appMeta).where(eq(appMeta.key, key)).limit(1)
    if (done[0]) continue
    const note = await repair.run()
    const stamp = new Date().toISOString()
    await db()
      .insert(appMeta)
      .values({ key, value: stamp })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: stamp } })
    console.log(`[repair] ${repair.id}: ${note}`)
  }
}
