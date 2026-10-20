// Load test for the arcade API as the site uses it in October 2026: the header, the home page, the Dailies, game
// pages and their boards, and runs played the way the games play them (run start, the run's own length, records,
// the save, the end card's reads, a race's ghost). load.mjs is the September crowd; this one follows the site.
//
// Usage: node site.mjs --visitors 300 --guests 100 --players 150 --seconds 120 [--base http://127.0.0.1:8806 | --bases <a>,<b>] [--timeline]
//   --visitors  signed-in people walking pages, with the header's polls
//   --guests    signed-out people walking pages
//   --players   signed-in people playing runs, end card included, with a page between runs now and then
// Each person comes from an address of their own (X-Forwarded-For; the API trusts one proxy), as on the real site.
// Throwaway database only: it makes accounts through /auth/magic-link, which only a non-production branch answers.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
// Several servers on one database (MULTI_INSTANCE=1): --bases http://127.0.0.1:8806,http://127.0.0.1:8807 sends each
// request to one of them at random, as a load balancer without sticky sessions does, and each person says back
// their last change's feed number for 15 s, as the site does (feedSync.ts).
const BASES = arg('bases', arg('base', 'http://127.0.0.1:8806')).split(',').map((b) => b.trim())
const BASE = BASES[0]
const FEED_HOLD_MS = 15_000
const VISITORS = Number(arg('visitors', 100))
const GUESTS = Number(arg('guests', 0))
const PLAYERS = Number(arg('players', 0))
const SECONDS = Number(arg('seconds', 60))
const TIMEOUT_MS = Number(arg('timeout', 30000))
const RAMP_MS = Number(arg('ramp', 10)) * 1000
// --timeline: every request's time, by when it finished, for a report in 30-second steps at the end.
const TIMELINE = process.argv.includes('--timeline')

const RACES = ['hotlap', 'swoop', 'lander', 'marblerun']
const ARCADE = ['asteroids', 'patriot', 'snake', 'crosswalk', 'stacker', 'pop', 'pellets', 'crumbtrail', 'bop', 'barrage', 'frenzy', 'fireflies', 'pileup']
const RANKED_DAILIES = RACES
const PERIODS = ['daily', 'weekly', 'monthly', 'all']

const pick = (list) => list[Math.floor(Math.random() * list.length)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const between = (lo, hi) => lo + Math.random() * (hi - lo)

/* ---------- measuring ---------- */

const samples = new Map() // label -> [ms]
const failures = new Map() // "label status code" -> count
const queries = new Map() // label -> database queries, summed (the API says each request's in X-Db-Queries)
const timeline = [] // [finished at, label, ms or null for a failure], with --timeline
let inFlight = 0
let peakInFlight = 0
let measuring = false

async function call(who, label, path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const t0 = performance.now()
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)
  try {
    const headers = { 'x-forwarded-for': who.ip, ...(init.headers ?? {}) }
    if (who.token) headers.authorization = `Bearer ${who.token}`
    if (init.body) headers['content-type'] = 'application/json'
    if (who.feedAfter && Date.now() - who.feedAt < FEED_HOLD_MS) headers['x-feed-after'] = String(who.feedAfter)
    const res = await fetch(BASES[Math.floor(Math.random() * BASES.length)] + path, { ...init, headers, signal: controller.signal })
    const fed = Number(res.headers.get('x-feed-id'))
    if (fed > (who.feedAfter ?? 0)) {
      who.feedAfter = fed
      who.feedAt = Date.now()
    }
    const body = await res.text()
    const ms = performance.now() - t0
    if (!res.ok) {
      let code = ''
      try {
        { const j = JSON.parse(body); code = j.code ?? String(j.error ?? "").slice(0, 50) + (j.details ? " " + JSON.stringify(j.details).slice(0, 160) : "") }
      } catch {}
      if (measuring) failures.set(`${label} ${res.status} ${code}`.trim(), (failures.get(`${label} ${res.status} ${code}`.trim()) ?? 0) + 1)
      if (measuring && TIMELINE) timeline.push([Date.now(), label, null])
      return null
    }
    if (measuring) {
      queries.set(label, (queries.get(label) ?? 0) + Number(res.headers.get('x-db-queries') ?? 0))
      if (!samples.has(label)) samples.set(label, [])
      samples.get(label).push(ms)
      if (TIMELINE) timeline.push([Date.now(), label, ms])
    }
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  } catch (err) {
    const kind = err.name === 'AbortError' ? 'timeout' : 'error'
    if (measuring) failures.set(`${label} ${kind}`, (failures.get(`${label} ${kind}`) ?? 0) + 1)
    if (measuring && TIMELINE) timeline.push([Date.now(), label, null])
    return null
  } finally {
    clearTimeout(timer)
    inFlight--
  }
}

/* ---------- the server's memory, sampled from outside (Windows) ---------- */

function serverPid(base = BASE) {
  try {
    const port = new URL(base).port
    const out = execSync('netstat -ano', { encoding: 'utf8' })
    const line = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
    return line ? line.trim().split(/\s+/).pop() : null
  } catch {
    return null
  }
}
function rssMb(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' })
    return Math.round(Number(out.split('","').pop().replace(/[^0-9]/g, '')) / 1024)
  } catch {
    return null
  }
}

/* ---------- people ---------- */

let ipCount = 0
const nextIp = () => {
  ipCount++
  return `10.${(ipCount >> 16) & 255}.${(ipCount >> 8) & 255}.${ipCount & 255}`
}

// Accounts kept between runs in site-accounts.json (they live in the throwaway database).
async function accounts(count) {
  const file = new URL('./site-accounts.json', import.meta.url)
  let have = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  if (have.length && have[0].base !== BASE) have = []
  const anon = { ip: nextIp() }
  for (let i = have.length; i < count; i++) {
    anon.ip = nextIp() // the sign-in limits are per address, as for people
    const email = `site-load-${i}@example.test`
    const link = await call(anon, 'setup', '/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) })
    const session = link && (await call(anon, 'setup', '/auth/verify', { method: 'POST', body: JSON.stringify({ token: link.verifyToken }) }))
    if (!session?.sessionToken) throw new Error(`no session for ${email}`)
    have.push({ base: BASE, name: 'SL' + String(i).padStart(5, '0'), token: session.sessionToken })
    if (i % 100 === 99) console.log(`  ${i + 1} accounts`)
  }
  writeFileSync(file, JSON.stringify(have))
  return have.slice(0, count)
}

/* ---------- what the site knows before anyone comes ---------- */

const NAMES = [] // seeded tags, for boards looked up "with you in it"
const BOOKS = {} // game -> [{id, lower}]
const RACE_TODAY = {} // race -> { n, times: [ms], ghost }
const ARCADE_SCORES = {} // game -> [score] from the week's board

async function learn() {
  const who = { ip: nextIp() }
  for (const game of ARCADE) {
    const board = await call(who, 'setup', `/leaderboards/${game}?period=weekly&limit=500`)
    const rows = board?.entries ?? board?.scores ?? board?.rows ?? []
    ARCADE_SCORES[game] = rows.map((r) => r.score).filter((s) => s > 0)
    for (const r of rows.slice(0, 60)) NAMES.push(r.name)
    const books = await call(who, 'setup', `/records/${game}?period=all`)
    BOOKS[game] = (books?.records ?? []).map((r) => ({ id: r.id, lower: r.direction === 'lower' }))
  }
  for (const game of RACES) {
    const board = await call(who, 'setup', `/leaderboards/${game}?period=daily&limit=500`)
    const rows = board?.entries ?? board?.scores ?? board?.rows ?? []
    const times = rows.map((r) => 1_000_000 - r.score).filter((ms) => ms > 0 && ms < 600_000)
    for (const r of rows.slice(0, 40)) NAMES.push(r.name)
    const records = await call(who, 'setup', `/tracks/${game}/records`)
    const n = todaysTrack(records)
    const ghost = n != null ? await call(who, 'setup', `/tracks/${game}/${n}/ghost`) : null
    RACE_TODAY[game] = { n, times, ghost: ghost?.path && ghost?.splits ? ghost : null }
  }
  if (!NAMES.length) NAMES.push('NOBODY')
}

// Today's course number from /tracks/:game/records: the course of the latest day (Hot Lap's tracks go round, so not
// the highest number; the site works it out from the date, on the same calendar).
function todaysTrack(records) {
  const list = (records?.tracks ?? []).filter((t) => Number.isFinite(t.track) && t.day != null)
  if (!list.length) return null
  return list.reduce((a, b) => (String(b.day) > String(a.day) ? b : a)).track
}

/* ---------- pages ---------- */

const scope = (who) => (who.name ? `&playerName=${who.name}` : '')
const tagOf = (who) => who.name ?? pick(NAMES)

// A full load of the site: what App and the header ask on any page (sections 0 and 0b of the map).
async function boot(who) {
  const tag = tagOf(who)
  const signedIn = Boolean(who.token)
  await Promise.all([
    call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=all${scope(who)}`),
    call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=daily${scope(who)}`),
    call(who, 'GET rank', `/leaderboards/rank?name=${tag}${scope(who)}`),
    signedIn && call(who, 'GET auth/me', '/auth/me'),
    call(who, 'GET poll', '/poll'),
    call(who, 'GET season', '/season'),
    signedIn && call(who, 'GET today', '/today'),
    signedIn && call(who, 'GET secrets/found', '/secrets/found'),
  ])
}
async function header(who) {
  if (!who.token) return
  const tag = tagOf(who)
  await Promise.all([
    call(who, 'GET trophies/summary', `/trophies/summary?name=${tag}`),
    call(who, 'GET invites', `/invites?status=pending&playerName=${tag}`),
    call(who, 'GET friends', '/friends'),
    call(who, 'GET notifications', '/notifications'),
  ])
}
// The header's own clocks: unread every 60 s, invites every 45 s.
async function polls(who) {
  if (!who.token) return
  const now = Date.now()
  const jobs = []
  if (now - (who.unreadAt ?? 0) > 60_000) {
    who.unreadAt = now
    jobs.push(call(who, 'GET notifications/unread', '/notifications/unread'))
  }
  if (now - (who.invitesAt ?? 0) > 45_000) {
    who.invitesAt = now
    jobs.push(call(who, 'GET invites', `/invites?status=pending&playerName=${tagOf(who)}`))
  }
  await Promise.all(jobs)
}

async function home(who) {
  const tag = tagOf(who)
  const p = pick(PERIODS)
  const book = pick(ARCADE)
  await Promise.all([
    who.token && call(who, 'GET today', '/today'),
    call(who, 'GET daily-hole', '/daily-hole'),
    ...RANKED_DAILIES.map((g) => call(who, 'GET days', `/leaderboards/${g}/days?name=${tag}`)),
    call(who, 'GET summary', `/leaderboards/summary?limit=10&period=${p}${scope(who)}`),
    p !== 'all' && call(who, 'GET summary', `/leaderboards/summary?limit=10&period=all${scope(who)}`),
    p !== 'daily' && call(who, 'GET summary', `/leaderboards/summary?limit=10&period=daily${scope(who)}`),
    call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=${p}${scope(who)}`),
    call(who, 'GET events', `/tournaments?playerName=${tag}`),
    call(who, 'GET events', `/tournaments?source=joined&playerName=${tag}`),
    call(who, 'GET board (around)', `/leaderboards/${pick(RACES)}?period=daily&players=1${scope(who)}&name=${tag}&limit=1&around=2`),
    call(who, 'GET board (around)', `/leaderboards/${pick(ARCADE)}?period=all&players=1${scope(who)}&name=${tag}&limit=1&around=2`),
    call(who, 'GET record book', `/records/${pick(ARCADE)}?period=all${scope(who)}&name=${tag}`),
    call(who, 'GET record book', `/records/${pick(ARCADE)}?period=all${scope(who)}&name=${tag}`),
    call(who, 'GET site records', `/records/site?name=${tag}${scope(who)}`),
    call(who, 'GET record book', `/records/${book}?period=all${scope(who)}`),
    call(who, 'GET groups', `/groups?playerName=${tag}`),
    call(who, 'GET hunt', '/hunt'),
  ])
}

async function dailies(who) {
  if (!who.token) return home(who)
  const tag = tagOf(who)
  await Promise.all([
    call(who, 'GET today', '/today'),
    call(who, 'GET daily-hole', '/daily-hole'),
    call(who, 'GET today/rivals', '/today/rivals'),
    call(who, 'GET events', `/tournaments?playerName=${tag}`),
    call(who, 'GET events', `/tournaments?source=joined&playerName=${tag}`),
    call(who, 'GET hunt', '/hunt'),
  ])
}

async function raceHub(who, game = pick(RACES)) {
  const tag = tagOf(who)
  const tab = Math.random()
  await Promise.all([
    call(who, 'GET board (top)', `/leaderboards/${game}?period=daily${scope(who)}&limit=1`),
    call(who, 'GET game events', `/tournaments/active-for/${game}`),
    call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=daily${scope(who)}`),
    call(who, 'GET summary', `/leaderboards/summary?limit=10&period=daily${scope(who)}`),
    call(who, 'GET summary', `/leaderboards/summary?limit=10&period=all${scope(who)}`),
    call(who, 'GET board (around)', `/leaderboards/${game}?period=daily&players=1${scope(who)}&name=${tag}&limit=1&around=0`),
    call(who, 'GET board (around)', `/leaderboards/${game}?period=${pick(['daily', 'daily', 'weekly', 'monthly'])}&players=1${scope(who)}&name=${tag}&limit=10&around=2`),
    who.token && call(who, 'GET today', '/today'),
    call(who, 'GET daily-hole', '/daily-hole'),
  ])
  if (tab < 0.15) {
    // The Past tab: the track records, your course bests, a few past courses' boards.
    const n = RACE_TODAY[game]?.n
    await Promise.all([
      call(who, 'GET tracks/records', `/tracks/${game}/records?name=${tag}`),
      who.token && call(who, 'GET course-bests', `/course-bests/${game}`),
      ...(n ? [1, 2, 3, 4].map((k) => call(who, 'GET track board', `/tracks/${game}/${Math.max(1, n - k)}/board?name=${tag}&limit=3`)) : []),
    ])
  } else if (tab < 0.25) {
    // The Records tab.
    await Promise.all(
      game === 'hotlap'
        ? [call(who, 'GET tracks/records', `/tracks/hotlap/records?name=${tag}`)]
        : [
            call(who, 'GET daily-records', `/leaderboards/${game}/daily-records?name=${tag}`),
            call(who, 'GET record (streak)', `/records/${game}/play-days-streak?period=all&limit=50&name=${tag}`),
          ],
    )
  }
}

async function arcadeHub(who, game = pick(ARCADE)) {
  const tag = tagOf(who)
  const p = pick(PERIODS)
  await Promise.all([
    call(who, 'GET board (top)', `/leaderboards/${game}?period=all${scope(who)}&limit=1`),
    call(who, 'GET game events', `/tournaments/active-for/${game}`),
    call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=${p}${scope(who)}`),
    call(who, 'GET summary', `/leaderboards/summary?limit=10&period=${p}${scope(who)}`),
    p !== 'all' && call(who, 'GET summary', `/leaderboards/summary?limit=10&period=all${scope(who)}`),
    call(who, 'GET board (around)', `/leaderboards/${game}?period=${p}&players=1${scope(who)}&name=${tag}&limit=10&around=2`),
    who.token && call(who, 'GET today', '/today'),
  ])
  if (Math.random() < 0.3) await call(who, 'GET record book', `/records/${game}?period=${pick(['all', p])}${scope(who)}&name=${tag}`)
}

// The Boards page: a period's standings and a game's board, paged.
async function boards(who) {
  const tag = tagOf(who)
  const p = pick(PERIODS)
  await Promise.all([
    call(who, 'GET summary', `/leaderboards/summary?limit=10&period=${p}${scope(who)}`),
    call(who, 'GET rank', `/leaderboards/rank?period=${p}&name=${tag}${scope(who)}&limit=25`),
    call(who, 'GET board', `/leaderboards/${pick([...RACES, ...ARCADE])}?period=${p}&players=1${scope(who)}&limit=25&offset=${pick([0, 0, 0, 25, 50])}`),
  ])
}

const PAGES = [
  [0.3, home],
  [0.2, dailies],
  [0.2, (w) => raceHub(w)],
  [0.15, (w) => arcadeHub(w)],
  [0.15, boards],
]
function pickPage() {
  let r = Math.random()
  for (const [w, page] of PAGES) if ((r -= w) < 0) return page
  return home
}

// Someone looking around: a full load, then a page every few seconds, a fresh load every so often.
async function visitor(who, end) {
  await sleep(Math.random() * RAMP_MS)
  let views = 0
  while (Date.now() < end) {
    if (views % 8 === 0) {
      await boot(who)
      await header(who)
    }
    await pickPage()(who)
    await polls(who)
    views++
    await sleep(between(3000, 12000)) // reading the page
  }
}

/* ---------- a run ---------- */

const TIME_BASE = 1_000_000

async function playRace(who, game) {
  const today = RACE_TODAY[game]
  const tag = who.name
  // The play page.
  await Promise.all([
    call(who, 'GET tickets', '/tickets'),
    call(who, 'GET board (top)', `/leaderboards/${game}?period=daily${scope(who)}`),
    today.n && call(who, 'GET ghost (#1)', `/tracks/${game}/${today.n}/ghost`),
    today.n && call(who, 'GET ghost (above)', `/tracks/${game}/${today.n}/ghost?above=${tag}`),
  ])
  const start = await call(who, 'POST runs/start', '/runs/start', { method: 'POST', body: JSON.stringify({ game }) })
  if (!start?.runId) return
  // A time a little behind someone on today's board, and the run lasts that long.
  const ms = Math.round((today.times.length ? pick(today.times) : 60000) * between(1.0, 1.25))
  await sleep(ms + 400)
  if (today.n) {
    call(who, 'POST course-bests', `/course-bests/${game}/${today.n}`, { method: 'POST', body: JSON.stringify({ ms, runId: start.runId, runLagMs: 0 }) })
  }
  await endCard(who, game, 'daily', TIME_BASE - ms, start.runId, [])
  if (today.ghost && Math.random() < 0.5) {
    // A best lap goes up as a ghost (here, the #1's path under this player's name, so it is a real lap of its time).
    const g = today.ghost
    const body = JSON.stringify({ name: tag, score: TIME_BASE - g.time, splits: g.splits, path: g.path })
    const sent = await call(who, 'POST ghost', `/tracks/${game}/${today.n}/ghost`, { method: 'POST', body })
    if (sent?.kept) await call(who, 'GET ghost (#1)', `/tracks/${game}/${today.n}/ghost`)
    await call(who, 'GET ghost (above)', `/tracks/${game}/${today.n}/ghost?above=${tag}`)
  }
}

async function playArcade(who, game) {
  await Promise.all([
    call(who, 'GET tickets', '/tickets'),
    call(who, 'GET board (top)', `/leaderboards/${game}?period=all${scope(who)}`),
  ])
  const start = await call(who, 'POST runs/start', '/runs/start', { method: 'POST', body: JSON.stringify({ game }) })
  if (!start?.runId) return
  const runMs = between(40_000, 150_000)
  await sleep(runMs)
  // Records hit during the run and at the end (Snake posts its length milestones, then longest and chain).
  const posted = []
  const books = BOOKS[game] ?? []
  for (let i = 0; i < 2 && books.length; i++) {
    const book = pick(books)
    const value = book.lower ? 5000 + Math.floor(Math.random() * 120000) : 2 + Math.floor(Math.random() ** 2 * 60)
    await call(who, 'POST record', `/records/${game}/${book.id}`, {
      method: 'POST',
      body: JSON.stringify({ name: who.name, score: value, device: 'phone', runId: start.runId, runLagMs: 0 }),
    })
    posted.push(book.id)
  }
  const seen = ARCADE_SCORES[game] ?? []
  const score = Math.max(1, Math.floor((seen.length ? pick(seen) : 100) * Math.random() ** 1.5))
  await endCard(who, game, pick(['weekly', 'all']), score, start.runId, posted)
}

// The ScoreSaveCard and the run report (map section 5 step 3), then the tickets line.
async function endCard(who, game, period, score, runId, posted) {
  const tag = who.name
  await call(who, 'GET bests', `/leaderboards/bests?name=${tag}&period=${period === 'daily' ? 'daily' : 'all'}${scope(who)}`)
  await Promise.all([
    call(who, 'GET rank', `/leaderboards/rank?name=${tag}${scope(who)}`),
    call(who, 'GET board (around)', `/leaderboards/${game}?period=${period}&players=1${scope(who)}&name=${tag}&limit=1&around=0`),
  ])
  const saved = await call(who, 'POST save', `/leaderboards/${game}`, {
    method: 'POST',
    headers: { 'x-tz-offset': '240' },
    body: JSON.stringify({ name: tag, score, device: 'phone', runId, runLagMs: 0 }),
  })
  if (!saved) return
  await call(who, 'GET rank', `/leaderboards/rank?name=${tag}${scope(who)}`)
  await Promise.all([
    call(who, 'GET board (around)', `/leaderboards/${game}?period=${period}&players=1${scope(who)}&name=${tag}&limit=3&around=1`),
    call(who, 'GET rank', `/leaderboards/rank?name=${tag}${scope(who)}`),
    ...posted.slice(0, 3).map((id) => call(who, 'GET record', `/records/${game}/${id}?period=all${scope(who)}&name=${tag}&limit=1`)),
    call(who, 'GET board (friends)', `/leaderboards/${game}?period=${period}&players=1&group=friends&name=${tag}&playerName=${tag}&limit=50`),
  ])
  await call(who, 'GET tickets', '/tickets')
}

// Someone playing: mostly today's races, some arcade games, a page now and then, the end card read for a moment.
async function player(who, end) {
  await sleep(Math.random() * RAMP_MS)
  await boot(who)
  while (Date.now() < end) {
    const race = Math.random() < 0.6
    const game = race ? pick(RACES) : pick(ARCADE)
    if (Math.random() < 0.3) await (race ? raceHub(who, game) : arcadeHub(who, game))
    if (race) await playRace(who, game)
    else await playArcade(who, game)
    await sleep(between(4000, 15000)) // the end card, then Play again
  }
}

/* ---------- the run ---------- */

const pids = BASES.map((base) => serverPid(base))
console.log('learning the world…')
await learn()
console.log(
  'races today:',
  Object.entries(RACE_TODAY)
    .map(([g, t]) => `${g} #${t.n} (${t.times.length} on the board${t.ghost ? ', ghost' : ''})`)
    .join(', '),
)
const signedIn = await accounts(VISITORS + PLAYERS)
const people = signedIn.map((a) => ({ ...a, ip: nextIp() }))
// Visitors look things up as a seeded player with runs on the boards ("with you in it"); players save as themselves.
const visitorsList = people.slice(0, VISITORS).map((p) => ({ ...p, name: pick(NAMES) }))
const playersList = people.slice(VISITORS)
const guestsList = Array.from({ length: GUESTS }, () => ({ ip: nextIp() }))

console.log(`${BASES.join(' + ')} · pid ${pids.join(', ')} · ${VISITORS} visitors · ${GUESTS} guests · ${PLAYERS} players · ${SECONDS}s`)
measuring = true
const t0 = Date.now()
const end = t0 + SECONDS * 1000
const rss = BASES.map(() => [])
const memTimer = setInterval(() => {
  pids.forEach((pid, i) => {
    const mb = pid ? rssMb(pid) : null
    if (mb) rss[i].push(mb)
  })
}, 3000)
await Promise.all([
  ...visitorsList.map((w) => visitor(w, end)),
  ...guestsList.map((w) => visitor(w, end)),
  ...playersList.map((w) => player(w, end)),
])
clearInterval(memTimer)
const wall = (Date.now() - t0) / 1000

/* ---------- the report ---------- */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
let total = 0
const rows = [...samples.entries()].sort().map(([label, list]) => {
  const s = list.slice().sort((a, b) => a - b)
  total += s.length
  return { request: label, ok: s.length, 'per s': (s.length / wall).toFixed(1), q: +((queries.get(label) ?? 0) / s.length).toFixed(1), p50: Math.round(pct(s, 50)), p95: Math.round(pct(s, 95)), p99: Math.round(pct(s, 99)), max: Math.round(s[s.length - 1]) }
})
const all = [...samples.values()].flat().sort((a, b) => a - b)
console.table(rows)
if (failures.size) console.table([...failures.entries()].sort((a, b) => b[1] - a[1]).map(([what, n]) => ({ failed: what, count: n })))
const failed = [...failures.values()].reduce((a, b) => a + b, 0)
if (TIMELINE) {
  // In 30-second steps: every request, and the saves on their own.
  const steps = new Map()
  for (const [at, label, ms] of timeline) {
    const step = Math.floor((at - t0) / 30_000)
    const row = steps.get(step) ?? { all: [], saves: [], failed: 0 }
    if (ms == null) row.failed++
    else {
      row.all.push(ms)
      if (label === 'POST save') row.saves.push(ms)
    }
    steps.set(step, row)
  }
  console.table(
    [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([step, { all, saves, failed }]) => {
      const a = all.sort((x, y) => x - y)
      const s = saves.sort((x, y) => x - y)
      return { from: `${step * 30}s`, requests: a.length, failed, p50: Math.round(pct(a, 50) ?? 0), p95: Math.round(pct(a, 95) ?? 0), saves: s.length, 'saves p50': Math.round(pct(s, 50) ?? 0), 'saves p95': Math.round(pct(s, 95) ?? 0) }
    }),
  )
}
console.log(
  `${total} ok, ${failed} failed, ${(total / wall).toFixed(0)} req/s over ${wall.toFixed(0)}s · all p50 ${Math.round(pct(all, 50))} ms, p95 ${Math.round(pct(all, 95))} ms, p99 ${Math.round(pct(all, 99))} ms · peak in flight ${peakInFlight} · server memory ${rss.map((list) => (list.length ? `${Math.min(...list)}–${Math.max(...list)} MB` : 'n/a')).join(', ')}`,
)
process.exit(0)
