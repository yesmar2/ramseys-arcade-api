// Two API servers on one database (MULTI_INSTANCE=1): a change made on one is
// seen on the other, straight away for the caller who made it. Throwaway
// database only.
import postgres from 'postgres'

const A = process.env.A ?? 'http://127.0.0.1:8796'
const B = process.env.B ?? 'http://127.0.0.1:8797'
const sql = postgres('postgres://postgres@127.0.0.1:55432/arcade_load', { max: 1 })

let problems = 0
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) problems++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** One caller: remembers the last feed number it was given and says it back, as the app does. */
function caller(token = null) {
  const self = {
    token,
    after: 0,
    async call(base, path, body, { method, noFeed } = {}) {
      const headers = { 'content-type': 'application/json' }
      if (self.token) headers.authorization = `Bearer ${self.token}`
      if (self.after && !noFeed) headers['x-feed-after'] = String(self.after)
      const res = await fetch(base + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
      const id = Number(res.headers.get('x-feed-id'))
      if (id > self.after) self.after = id
      return { status: res.status, feedId: id || null, body: await res.json().catch(() => null) }
    },
  }
  return self
}

async function signIn(email) {
  const c = caller()
  const link = await c.call(A, '/auth/magic-link', { email })
  const verified = await c.call(A, '/auth/verify', { token: link.body.verifyToken })
  c.token = verified.body.sessionToken
  return c
}

const stamp = Date.now().toString(36).slice(-4).toUpperCase()

// ---- A score saved on A is on B's board.
{
  const p = await signIn(`multi-a-${stamp}@example.test`)
  const tag = `MA${stamp}`
  await p.call(A, '/names/claim', { name: tag })
  const saved = await p.call(A, '/leaderboards/snake', { name: tag, score: 777, device: 'desktop' })
  expect(saved.status < 300 && saved.feedId > 0, `a save on A answers with its feed number (${saved.status}, #${saved.feedId})`)
  const stranger = caller()
  const early = await stranger.call(B, `/leaderboards/snake?period=daily&name=${tag}`)
  console.log(`     (B without the number, at once: ${early.body?.you ? 'has it' : 'not yet'})`)
  const onB = await p.call(B, `/leaderboards/snake?period=daily&name=${tag}`)
  expect(onB.body?.you?.score === 777, `B's board has it for the saver, at once (${JSON.stringify(onB.body?.you)})`)
  await wait(1200)
  const later = await stranger.call(B, `/leaderboards/snake?period=daily&name=${tag}`)
  expect(later.body?.you?.score === 777, 'and for anyone a moment later')
  const rankA = await stranger.call(A, `/leaderboards/rank?game=snake&name=${tag}`)
  const rankB = await stranger.call(B, `/leaderboards/rank?game=snake&name=${tag}`)
  expect(JSON.stringify(rankA.body) === JSON.stringify(rankB.body), `A and B give the same rank (${JSON.stringify(rankB.body)?.slice(0, 120)})`)

  // A record saved on A is in B's book.
  const books = await stranger.call(A, '/records/snake')
  const book = books.body?.records?.[0]
  if (book) {
    const rec = await p.call(A, `/records/snake/${book.id}`, { name: tag, score: 1, device: 'desktop' })
    console.log(`     (record ${book.id}: ${rec.status} improved=${rec.body?.improved})`)
    if (rec.body?.improved) {
      const onBook = await p.call(B, `/records/snake/${book.id}?name=${tag}`)
      const mine = JSON.stringify(onBook.body).includes(tag)
      expect(mine, `B's record book has the record saved on A`)
    }
  } else {
    console.log('     (no snake record book to try)')
  }

  // A log-out on A ends the session on B too.
  const meB = await p.call(B, '/auth/me')
  expect(meB.status === 200, 'B knows the session')
  const out = await p.call(A, '/auth/logout', {})
  expect(out.status === 200 && out.feedId > 0, `log out on A (#${out.feedId})`)
  const meB2 = await p.call(B, '/auth/me')
  expect(meB2.status === 401, `B has dropped it (${meB2.status})`)
}

// ---- A tag's avatar set on A shows on B's board.
{
  const p = await signIn(`multi-b-${stamp}@example.test`)
  const tag = `MB${stamp}`
  await p.call(A, '/names/claim', { name: tag })
  await p.call(A, '/leaderboards/pop', { name: tag, score: 4321, device: 'desktop' })
  const onB1 = await p.call(B, `/leaderboards/pop?period=daily&name=${tag}`)
  const before = onB1.body?.you?.avatarId ?? null
  const avatarId = 'a2:m:2:stripes:3:4:bold:none:none'
  const set = await p.call(A, `/names/${tag}/avatar`, { avatarId }, { method: 'PUT' })
  console.log(`     (avatar set: ${set.status} ${JSON.stringify(set.body)?.slice(0, 100)})`)
  const onB2 = await p.call(B, `/leaderboards/pop?period=daily&name=${tag}`)
  expect(set.status < 300 && onB2.body?.you?.avatarId === avatarId, `B shows the avatar set on A (${before} -> ${onB2.body?.you?.avatarId})`)

  // A group made on A is there on B.
  const made = await p.call(A, '/groups', { name: `Multi ${stamp}`, playerName: tag })
  expect(made.status === 201, `group made on A (${made.status} ${made.body?.error ?? ''})`)
  const gid = made.body?.group?.id
  const onB = await p.call(B, `/groups/${gid}`)
  expect(onB.status === 200 && onB.body?.group?.id === gid, `B has the group at once (${onB.status})`)
  const renamed = await p.call(A, `/groups/${gid}/rename`, { name: `Renamed ${stamp}` })
  const onB3 = await p.call(B, `/groups/${gid}`)
  expect(renamed.status === 200 && onB3.body?.group?.name === `Renamed ${stamp}`, `B has its new name (${onB3.body?.group?.name})`)
}

// ---- The daily event: joined on A, run posted on B, one seat, same standings on both.
{
  const p = await signIn(`multi-c-${stamp}@example.test`)
  const tag = `MC${stamp}`
  await p.call(A, '/names/claim', { name: tag })
  const list = await p.call(A, '/tournaments')
  const daily = list.body?.tournaments?.find((t) => t.cadence === 'daily' && t.status === 'active')
  const joined = await p.call(A, `/tournaments/${daily.id}/join`, { name: tag })
  expect(joined.status === 201, `joined the daily on A (${joined.status})`)
  const posted = await p.call(B, `/tournaments/${daily.id}/scores`, { name: tag, game: daily.games[0], score: 4242 })
  expect(posted.status < 300, `run posted on B (${posted.status} ${posted.body?.error ?? ''})`)
  await wait(1200)
  const seats = await sql`select count(*)::int as n from tournament_players where tournament_id = ${daily.id} and name = ${tag}`
  expect(seats[0].n === 1, `one seat, not two (${seats[0].n})`)
  const dA = await caller().call(A, `/tournaments/${daily.id}?playerName=${tag}`)
  const dB = await caller().call(B, `/tournaments/${daily.id}?playerName=${tag}`)
  const rowA = dA.body?.standings?.find((r) => r.name === tag)
  const rowB = dB.body?.standings?.find((r) => r.name === tag)
  expect(rowA?.totalPoints != null && JSON.stringify(rowA) === JSON.stringify(rowB), `A and B both have the run (${JSON.stringify(rowB)?.slice(0, 100)})`)
  expect(JSON.stringify(dA.body) === JSON.stringify(dB.body), 'the whole daily page is the same on A and B')
}

// ---- A capped event, joined from both servers at once: never past its cap.
{
  const host = await signIn(`multi-host-${stamp}@example.test`)
  const hostTag = `MH${stamp}`
  await host.call(A, '/names/claim', { name: hostTag })
  const made = await host.call(A, '/tournaments', {
    title: `Cap ${stamp}`,
    games: ['snake'],
    maxAttempts: 0,
    maxPlayers: 3,
    durationHours: 24,
  })
  expect(made.status === 201, `capped event made on A (${made.status} ${made.body?.error ?? ''})`)
  const ev = made.body?.tournament
  const invite = ev?.inviteCode
  const joiners = await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async (i) => {
      const c = await signIn(`multi-j${i}-${stamp}@example.test`)
      const tag = `J${i}${stamp}`
      await c.call(A, '/names/claim', { name: tag })
      return { c, tag, base: i % 2 ? B : A }
    }),
  )
  const results = await Promise.all(joiners.map((j) => j.c.call(j.base, `/tournaments/${ev.id}/join`, { name: j.tag, invite })))
  const joinedCount = results.filter((r) => r.status === 201).length
  const full = results.filter((r) => r.body?.code === 'EVENT_FULL').length
  console.log(`     (joins: ${results.map((r) => r.status + (r.body?.code ? ':' + r.body.code : '')).join(' ')})`)
  const rows = await sql`select count(*)::int as n from tournament_players where tournament_id = ${ev.id}`
  expect(rows[0].n === 3 && joinedCount === 3 && full === 3, `three seats taken, three turned away (${rows[0].n} rows, ${joinedCount} joined, ${full} full)`)
  await wait(1200)
  const eA = await host.call(A, `/tournaments/${ev.id}?invite=${invite}`)
  const eB = await host.call(B, `/tournaments/${ev.id}?invite=${invite}`)
  expect(eA.body?.players?.length === 3 && JSON.stringify(eA.body) === JSON.stringify(eB.body), `A and B show the same three (${eA.body?.players?.length}, ${eB.body?.players?.length})`)
}

// ---- A bracket filled from both servers at once is drawn once.
{
  const host = await signIn(`multi-bh-${stamp}@example.test`)
  const hostTag = `BH${stamp}`
  await host.call(A, '/names/claim', { name: hostTag })
  const made = await host.call(A, '/tournaments', {
    title: `Draw ${stamp}`,
    games: ['snake'],
    maxAttempts: 3,
    maxPlayers: 4,
    durationHours: 24,
    kind: 'bracket',
  })
  expect(made.status === 201, `bracket made on A (${made.status} ${made.body?.error ?? ''})`)
  const ev = made.body?.tournament
  const invite = ev?.inviteCode
  const joiners = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const c = await signIn(`multi-bj${i}-${stamp}@example.test`)
      const tag = `K${i}${stamp}`
      await c.call(A, '/names/claim', { name: tag })
      return { c, tag, base: i % 2 ? B : A }
    }),
  )
  const results = await Promise.all(joiners.map((j) => j.c.call(j.base, `/tournaments/${ev.id}/join`, { name: j.tag, invite })))
  console.log(`     (joins: ${results.map((r) => r.status + (r.body?.code ? ':' + r.body.code : '')).join(' ')})`)
  await wait(1200)
  const eA = await host.call(A, `/tournaments/${ev.id}?invite=${invite}`)
  const eB = await host.call(B, `/tournaments/${ev.id}?invite=${invite}`)
  const bracket = eA.body?.bracket
  expect(Boolean(bracket?.lockedAt) && eA.body?.players?.length === 4, `drawn with four (${eA.body?.players?.length} players, locked ${Boolean(bracket?.lockedAt)})`)
  expect(JSON.stringify(eA.body) === JSON.stringify(eB.body), 'A and B have the same draw')
  const stored = await sql`select data->'bracket'->'matches' as matches from tournaments where id = ${ev.id}`
  const drawOf = (list, ids) => JSON.stringify((list ?? []).filter((m) => !m.void).map((m) => [m.id, m.round, m.slot, ids(m), m.winnerId ?? null]))
  expect(
    drawOf(stored[0].matches, (m) => m.playerIds.map((id) => id ?? null)) === drawOf(bracket?.matches, (m) => m.players.map((p) => (p?.id ? p.id : null))),
    'and it is the draw in the database',
  )
  // First round played from both servers at once.
  const matches = (bracket?.matches ?? []).filter((m) => m.round === 1)
  const posts = []
  for (const j of joiners) {
    const seat = eA.body.players.find((p) => p.name === j.tag)
    if (!matches.some((m) => m.players.some((side) => side?.id === seat?.id))) continue
    posts.push(j.c.call(j.base, `/tournaments/${ev.id}/scores`, { name: j.tag, game: 'snake', score: 10 + Math.floor(Math.random() * 90) }))
  }
  const posted = await Promise.all(posts)
  console.log(`     (round one runs: ${posted.map((r) => r.status + (r.body?.code ? ':' + r.body.code : '')).join(' ')})`)
  await wait(1500)
  const fA = await host.call(A, `/tournaments/${ev.id}?invite=${invite}`)
  const fB = await host.call(B, `/tournaments/${ev.id}?invite=${invite}`)
  const runs = await sql`select count(*)::int as n from tournament_scores where tournament_id = ${ev.id}`
  expect(runs[0].n === posted.filter((r) => r.status < 300).length, `every run is a row (${runs[0].n})`)
  expect(JSON.stringify(fA.body) === JSON.stringify(fB.body), 'A and B agree after the runs')
}

// ---- One server sweeps.
{
  const leases = await sql`select name, holder, until from leases`
  console.log(`     (leases: ${JSON.stringify(leases.map((l) => [l.name, l.holder]))})`)
  const sweep = leases.filter((l) => l.name === 'sweep')
  expect(sweep.length <= 1, `one sweep lease at most (${sweep.length})`)
  const feed = await sql`select kind, count(*)::int as n from change_feed group by kind order by kind`
  console.log(`     (feed: ${feed.map((r) => `${r.kind} ${r.n}`).join(', ')})`)
}

await sql.end()
console.log(problems ? `${problems} problems` : 'all as expected')
process.exit(problems ? 1 : 0)
