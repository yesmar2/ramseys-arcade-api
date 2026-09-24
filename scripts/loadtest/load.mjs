// Load test for the arcade API: a crowd of virtual players browsing boards and saving scores.
// Usage: node load.mjs --users 200 --seconds 60 --writers 100 [--base http://127.0.0.1:8796] [--mix browse|report]
// Several servers on one database (MULTI_INSTANCE=1): --bases http://127.0.0.1:8796,http://127.0.0.1:8797
// sends each request to one of them at random, the way a load balancer without sticky sessions would,
// and each player says back the feed number of their last change, as the app does.
// Throwaway database only. Prints per-request latency percentiles, errors and the server's memory.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASES = arg('bases', arg('base', 'http://127.0.0.1:8796')).split(',').map((b) => b.trim())
const BASE = BASES[0]
const USERS = Number(arg('users', 100))
const SECONDS = Number(arg('seconds', 60))
const WRITERS = Number(arg('writers', 0))
const TIMEOUT_MS = Number(arg('timeout', 30000))
const PLAYERS = 20000
const GAMES = ['asteroids', 'patriot', 'snake', 'crosswalk', 'stacker', 'centroid', 'pop', 'pellets', 'findbug', 'crumbtrail', 'bop', 'putt', 'barrage', 'frenzy', 'fireflies']
const TOPS = { asteroids: 20000, patriot: 15000, snake: 1500, crosswalk: 300, stacker: 40, centroid: 10000, pop: 2500, pellets: 5000, crumbtrail: 3000, bop: 200, putt: 100, barrage: 50000, frenzy: 5000, fireflies: 60 }
const PERIODS = ['daily', 'weekly', 'monthly', 'all']

const pick = (list) => list[Math.floor(Math.random() * list.length)]
const player = () => 'LT' + String(Math.floor(Math.random() ** 1.6 * PLAYERS) + 1).padStart(5, '0')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- measuring ---------- */

const samples = new Map() // label -> [ms]
const failures = new Map() // label -> count
let inFlight = 0
let peakInFlight = 0

/** A player's last change's feed number, said back for 15 s, as the app does (feedSync.ts). */
const FEED_HOLD_MS = 15_000

async function call(label, path, init = {}, feed = null) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const t0 = performance.now()
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)
  try {
    const headers = { ...(init.headers ?? {}) }
    if (feed?.after && Date.now() - feed.at < FEED_HOLD_MS) headers['x-feed-after'] = String(feed.after)
    const res = await fetch(pick(BASES) + path, { ...init, headers, signal: controller.signal })
    const said = Number(res.headers.get('x-feed-id'))
    if (feed && said > feed.after) {
      feed.after = said
      feed.at = Date.now()
    }
    const body = await res.text()
    const ms = performance.now() - t0
    if (!res.ok) {
      failures.set(`${label} ${res.status}`, (failures.get(`${label} ${res.status}`) ?? 0) + 1)
      return null
    }
    if (!samples.has(label)) samples.set(label, [])
    samples.get(label).push(ms)
    return body
  } catch (err) {
    const kind = err.name === 'AbortError' ? 'timeout' : 'error'
    failures.set(`${label} ${kind}`, (failures.get(`${label} ${kind}`) ?? 0) + 1)
    return null
  } finally {
    clearTimeout(timer)
    inFlight--
  }
}

/* ---------- the server's memory, sampled from outside ---------- */

function serverPid(base) {
  const port = new URL(base).port
  const out = execSync('netstat -ano', { encoding: 'utf8' })
  const line = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
  return line ? line.trim().split(/\s+/).pop() : null
}

function rssMb(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' })
    const kb = Number(out.split('","').pop().replace(/[^0-9]/g, ''))
    return Math.round(kb / 1024)
  } catch {
    return null
  }
}

/* ---------- accounts for the players who save ---------- */

async function accounts(count) {
  const file = new URL('./accounts.json', import.meta.url)
  const have = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  for (let i = have.length; i < count; i++) {
    const email = `load-${i}@example.test`
    const link = await fetch(`${BASE}/auth/magic-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then((r) => r.json())
    const session = await fetch(`${BASE}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.verifyToken }) }).then((r) => r.json())
    if (!session.sessionToken) throw new Error(`no session for ${email}: ${JSON.stringify(session).slice(0, 200)}`)
    have.push({ name: 'LW' + String(i).padStart(5, '0'), token: session.sessionToken })
  }
  writeFileSync(file, JSON.stringify(have))
  return have.slice(0, count)
}

/* ---------- what a player does ---------- */

// Each game's record books, read from the API once: id and whether lower is better.
const BOOKS = {}
async function learnBooks() {
  for (const game of GAMES) {
    const res = await fetch(`${BASE}/records/${game}?period=all`)
    const body = await res.json()
    BOOKS[game] = (body.records ?? []).map((r) => ({ id: r.id, lower: r.direction === 'lower' }))
  }
}

// The official events running now (the day's and the week's), read from the API once.
let EVENTS = []
async function learnEvents() {
  const body = await (await fetch(`${BASE}/tournaments?source=official`)).json()
  EVENTS = (body.tournaments ?? [])
    .filter((t) => t.status === 'active' && (t.cadence === 'daily' || t.cadence === 'weekly'))
    .map((t) => ({ id: t.id, games: t.games }))
}
const eventGames = () => [...new Set(EVENTS.flatMap((e) => e.games))].filter((g) => g in TOPS)

// Reading: the home page, a game's page, an event, the boards, a profile.
async function browse() {
  const name = player()
  const game = pick(GAMES)
  const period = pick(PERIODS)
  const r = Math.random()
  if (r < 0.2) {
    // Home: the standings strip, the site's records, one game's book, and the events on now.
    await Promise.all([
      call('GET summary', `/leaderboards/summary?period=${period}&limit=3`),
      call('GET rank', `/leaderboards/rank?period=${period}&limit=5`),
      call('GET site records', `/records/site?name=${name}`),
      call('GET record book', `/records/${game}?period=all`),
      call('GET events', `/tournaments?playerName=${name}`),
      call('GET events', `/tournaments?source=joined&playerName=${name}`),
    ])
  } else if (r < 0.35) {
    // A game's page: its board, your bests, its record book with you in it, its events.
    await Promise.all([
      call('GET board', `/leaderboards/${game}?period=${period}&limit=100&name=${name}`),
      call('GET bests', `/leaderboards/bests?name=${name}`),
      call('GET record book', `/records/${game}?period=all&name=${name}`),
      call('GET game events', `/tournaments/active-for/${game}`),
    ])
  } else if (r < 0.4 && EVENTS.length) {
    // An event's page, with you in its standings.
    await call('GET event', `/tournaments/${pick(EVENTS).id}?playerName=${name}`)
  } else if (r < 0.6) {
    await Promise.all([
      call('GET summary', `/leaderboards/summary?period=${period}`),
      call('GET rank', `/leaderboards/rank?period=${period}&name=${name}`),
    ])
  } else if (r < 0.85) {
    await call('GET board', `/leaderboards/${game}?period=${period}&limit=25`)
  } else {
    await call('GET rank', `/leaderboards/rank?period=${period}&name=${name}`)
  }
}

// A run the way a game and its end card make one: records during it, the save, then the card's reads.
async function playRun(account) {
  const feed = (account.feed ??= { after: 0, at: 0 })
  // Four runs in ten on the events' games: an event is where a crowd gathers.
  const hot = eventGames()
  const game = hot.length && Math.random() < 0.4 ? pick(hot) : pick(Object.keys(TOPS))
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${account.token}` }
  const books = BOOKS[game] ?? []
  const posted = []
  for (let i = 0; i < 2 && books.length; i++) {
    const book = pick(books)
    const value = book.lower ? 5000 + Math.floor(Math.random() * 120000) : 2 + Math.floor(Math.random() ** 2 * 60)
    await call(
      'POST record',
      `/records/${game}/${book.id}`,
      { method: 'POST', headers: auth, body: JSON.stringify({ name: account.name, score: value, device: 'desktop' }) },
      feed,
    )
    posted.push(book.id)
  }
  const score = Math.max(1, Math.floor(Math.random() ** 2 * TOPS[game]))
  const saved = await call(
    'POST save',
    `/leaderboards/${game}`,
    { method: 'POST', headers: auth, body: JSON.stringify({ name: account.name, score, device: 'desktop' }) },
    feed,
  )
  if (!saved) return
  // Then into each event the game is in, as the end card does.
  for (const event of EVENTS.filter((e) => e.games.includes(game))) {
    await call(
      'POST event score',
      `/tournaments/${event.id}/scores`,
      { method: 'POST', headers: auth, body: JSON.stringify({ name: account.name, game, score }) },
      feed,
    )
  }
  await Promise.all([
    call('GET board', `/leaderboards/${game}?period=weekly&limit=500&name=${account.name}`, {}, feed),
    call('GET rank', `/leaderboards/rank?period=weekly&name=${account.name}`, {}, feed),
    ...posted.map((id) => call('GET record', `/records/${game}/${id}?period=all&name=${account.name}&limit=1`, {}, feed)),
  ])
}

/* ---------- the run ---------- */

const pids = BASES.map(serverPid)
const writers = WRITERS ? await accounts(WRITERS) : []
await learnBooks()
await learnEvents()
// The players join the events on now, the way they would from its page.
for (const account of writers) {
  for (const event of EVENTS) {
    await call('POST event join', `/tournaments/${event.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ name: account.name }),
    })
  }
}
if (failures.size) console.log('joining the events failed:', Object.fromEntries(failures))
samples.clear()
failures.clear()
console.log(`${BASES.join(' + ')} · server pid ${pids.join(', ')} · ${USERS} browsing · ${writers.length} saving · ${SECONDS}s`)
const rss = BASES.map(() => [])
const end = Date.now() + SECONDS * 1000
const memTimer = setInterval(() => {
  pids.forEach((pid, i) => {
    const mb = pid ? rssMb(pid) : null
    if (mb) rss[i].push(mb)
  })
}, 2000)

const browsers = Array.from({ length: USERS }, async () => {
  await sleep(Math.random() * 2000)
  while (Date.now() < end) {
    await browse()
    await sleep(500 + Math.random() * 1500) // a person reads for a moment
  }
})
const savers = writers.map(async (account) => {
  await sleep(Math.random() * 5000)
  while (Date.now() < end) {
    await playRun(account)
    await sleep(20000 + Math.random() * 20000) // a run every 20–40 s, inside the 40-per-10-minutes limit
  }
})
await Promise.all([...browsers, ...savers])
clearInterval(memTimer)

/* ---------- the report ---------- */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
const rows = [...samples.entries()].sort().map(([label, list]) => {
  const s = list.slice().sort((a, b) => a - b)
  return {
    request: label,
    ok: s.length,
    'per s': (s.length / SECONDS).toFixed(1),
    p50: Math.round(pct(s, 50)),
    p95: Math.round(pct(s, 95)),
    p99: Math.round(pct(s, 99)),
    max: Math.round(s[s.length - 1]),
  }
})
console.table(rows)
if (failures.size) console.table([...failures.entries()].map(([what, n]) => ({ failed: what, count: n })))
const memory = rss.map((list) => (list.length ? `${Math.min(...list)}–${Math.max(...list)} MB` : 'n/a')).join(', ')
console.log(`peak requests in flight ${peakInFlight} · server memory ${memory}`)
