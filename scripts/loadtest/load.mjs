// Load test for the arcade API: a crowd of virtual players browsing boards and saving scores.
// Usage: node load.mjs --users 200 --seconds 60 --writers 100 [--base http://127.0.0.1:8796]
// Throwaway database only. Prints per-request latency percentiles, errors and the server's memory.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8796')
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

async function call(label, path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const t0 = performance.now()
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)
  try {
    const res = await fetch(BASE + path, { ...init, signal: controller.signal })
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

function serverPid() {
  const port = new URL(BASE).port
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

// Reading: the home page, a game's page, the boards, a profile.
async function browse() {
  const name = player()
  const game = pick(GAMES)
  const period = pick(PERIODS)
  const r = Math.random()
  if (r < 0.3) {
    await Promise.all([
      call('GET summary', `/leaderboards/summary?period=${period}`),
      call('GET rank', `/leaderboards/rank?period=${period}&name=${name}`),
    ])
  } else if (r < 0.6) {
    await Promise.all([
      call('GET board', `/leaderboards/${game}?period=${period}&limit=25&name=${name}`),
      call('GET bests', `/leaderboards/bests?name=${name}`),
    ])
  } else if (r < 0.85) {
    await call('GET board', `/leaderboards/${game}?period=${period}&limit=25`)
  } else {
    await call('GET rank', `/leaderboards/rank?period=${period}&name=${name}`)
  }
}

// Saving a run the way the end-of-run card does: the save, then the board and the standings read back.
async function playRun(account) {
  const game = pick(Object.keys(TOPS))
  const score = Math.max(1, Math.floor(Math.random() ** 2 * TOPS[game]))
  const saved = await call('POST save', `/leaderboards/${game}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ name: account.name, score, device: 'desktop' }),
  })
  if (!saved) return
  await Promise.all([
    call('GET board', `/leaderboards/${game}?period=weekly&limit=500&name=${account.name}`),
    call('GET rank', `/leaderboards/rank?period=weekly&name=${account.name}`),
  ])
}

/* ---------- the run ---------- */

const pid = serverPid()
const writers = WRITERS ? await accounts(WRITERS) : []
console.log(`base ${BASE} · server pid ${pid} · ${USERS} browsing · ${writers.length} saving · ${SECONDS}s`)
const rss = []
const end = Date.now() + SECONDS * 1000
const memTimer = setInterval(() => {
  const mb = pid ? rssMb(pid) : null
  if (mb) rss.push(mb)
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
console.log(`peak requests in flight ${peakInFlight} · server memory ${rss.length ? `${Math.min(...rss)}–${Math.max(...rss)} MB` : 'n/a'}`)
