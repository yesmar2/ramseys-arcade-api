// The same saves, at the same moments, through the old code and the new, each on its own copy of one world, and
// every answer compared field by field (ids, clocks and a new tag's minted token aside). Rounds of ten at once,
// each a different game and account: four races and six arcade games, with repeat players, a first save under a
// tag, a run sent twice and someone else's tag among them. Then what the site reads for those accounts.
//
// Copy the world first, with no server on it: `create database arcade_a template arcade_load2` and the same for
// arcade_b. Start the old code on one (8807) and the new on the other (8806), then:
//   node saves-check.mjs [--old http://127.0.0.1:8807] [--new http://127.0.0.1:8806] [--rounds 3]
// Uses site.mjs's accounts (site-accounts.json, made before the copy), and seeded-signin.mjs's if there.
import { existsSync, readFileSync } from 'node:fs'
import { compareReads, diff } from './reads-check.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const OLD = arg('old', 'http://127.0.0.1:8807')
const NEW = arg('new', 'http://127.0.0.1:8806')
const ROUNDS = Number(arg('rounds', 3))
const accounts = JSON.parse(readFileSync(new URL('./site-accounts.json', import.meta.url), 'utf8'))
const seededFile = new URL('./seeded-accounts.json', import.meta.url)
const seeded = existsSync(seededFile) ? JSON.parse(readFileSync(seededFile, 'utf8')) : []

const RACES = ['hotlap', 'swoop', 'lander', 'marblerun']
const ARCADE = { snake: 6, asteroids: 150, crosswalk: 5, stacker: 3, pop: 40, pellets: 30, crumbtrail: 4, bop: 4, barrage: 200, frenzy: 12, fireflies: 2, pileup: 80 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seed = 11
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)

async function post(base, who, path, body, ip) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-tz-offset': '240' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, body: json, ms: Number(res.headers.get('x-elapsed-ms')) }
}

let compared = 0
let same = 0
const problems = []

function check(label, x, y) {
  compared++
  // A tag claimed by this save gets a token minted on each server.
  const d = x.status === y.status ? diff(x.body, y.body).filter((line) => !line.startsWith('.token:')) : [`status ${x.status} vs ${y.status}`]
  if (!d.length) same++
  else problems.push(`${label}: ${d.slice(0, 6).join(' · ')}`)
  console.log(`${d.length ? 'DIFF' : 'same'} ${x.status} ${label} (old ${x.ms} ms, new ${y.ms} ms)`)
}

// One save, the same on both: a run started on each, the run waited out, then saved on each at once.
async function both(who, game, score, waitMs, ip, opts = {}) {
  const [a, b] = await Promise.all([OLD, NEW].map((base) => post(base, who, '/runs/start', { game }, ip)))
  if (!a.body.runId || !b.body.runId) {
    problems.push(`${game} ${who.name}: runs/start ${a.status}/${b.status}`)
    return
  }
  await sleep(waitMs)
  const body = (runId) => ({ name: opts.name ?? who.name, score, device: 'phone', runId, runLagMs: 0 })
  const save = () => Promise.all([post(OLD, who, `/leaderboards/${game}`, body(a.body.runId), ip), post(NEW, who, `/leaderboards/${game}`, body(b.body.runId), ip)])
  check(`${game} ${opts.name ?? who.name} ${score}`, ...(await save()))
  // The same run sent again: spent already.
  if (opts.again) check(`${game} ${who.name} again`, ...(await save()))
}

const savers = new Set()
for (let round = 0; round < ROUNDS; round++) {
  const jobs = []
  RACES.forEach((game, i) => {
    const who = accounts[round === 0 ? 300 + i : 440 + i]
    savers.add(who)
    const ms = 61000 + Math.floor(rand() * 9000)
    jobs.push(both(who, game, 1_000_000 - ms, ms + 1200, `10.7.${round}.${i}`, { again: round === 1 && i === 0 }))
  })
  const games = Object.keys(ARCADE)
  for (let i = 0; i < 6; i++) {
    const game = games[(round * 6 + i) % games.length]
    // A visitor's account (one site.mjs never saves with) saves for the first time in the last round.
    const who = accounts[round === 2 && i === 5 ? 200 : 450 + i]
    savers.add(who)
    const score = Math.max(1, Math.round(ARCADE[game] * (0.5 + rand())))
    jobs.push(both(who, game, score, 8000, `10.7.${round}.${10 + i}`, { again: round === 0 && i === 0 }))
  }
  // Someone else's tag.
  if (round === 1) jobs.push(both(accounts[460], 'snake', 3, 6000, '10.7.9.1', { name: accounts[450].name }))
  await Promise.all(jobs)
  console.log(`round ${round + 1} done`)
}

const reads = await compareReads(OLD, NEW, [...savers, ...seeded])
console.log(`\n${same} of ${compared} saves answered the same; ${reads.same} of ${reads.n} reads after them`)
for (const p of [...problems, ...reads.problems]) console.log('  ' + p)
process.exit(problems.length || reads.problems.length ? 1 : 0)
