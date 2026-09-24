// Save a batch of scores through one server, for the read-after-write comparison.
// Usage: node writes.mjs --base http://127.0.0.1:8796 --writers 30 --saves 60
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8796')
const WRITERS = Number(arg('writers', 30))
const SAVES = Number(arg('saves', 60))
const GAMES = ['asteroids', 'snake', 'crosswalk', 'stacker', 'pop', 'findbug', 'putt', 'barrage']
const TOPS = { asteroids: 20000, snake: 1500, crosswalk: 300, stacker: 40, pop: 2500, putt: 100, barrage: 50000 }

const file = new URL('./accounts.json', import.meta.url)
const accounts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
for (let i = accounts.length; i < WRITERS; i++) {
  const email = `load-${i}@example.test`
  const post = (path, body) =>
    fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const link = await post('/auth/magic-link', { email })
  const session = await post('/auth/verify', { token: link.verifyToken })
  if (!session.sessionToken) throw new Error(`no session for ${email}: ${JSON.stringify(session).slice(0, 200)}`)
  accounts.push({ name: 'LW' + String(i).padStart(5, '0'), token: session.sessionToken })
}
writeFileSync(file, JSON.stringify(accounts))

let ok = 0
const failed = {}
for (let i = 0; i < SAVES; i++) {
  const account = accounts[i % WRITERS]
  const game = GAMES[i % GAMES.length]
  // Time boards store the base minus the run's milliseconds.
  const score = game === 'findbug' ? 1_000_000 - (20000 + Math.floor(Math.random() * 150000)) : Math.max(1, Math.floor(Math.random() * TOPS[game]))
  const res = await fetch(`${BASE}/leaderboards/${game}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ name: account.name, score, device: 'desktop' }),
  })
  if (res.ok) ok++
  else {
    const body = await res.text()
    failed[`${res.status} ${body.slice(0, 80)}`] = (failed[`${res.status} ${body.slice(0, 80)}`] ?? 0) + 1
  }
}
console.log(`${ok}/${SAVES} saved through ${BASE}`, failed)
