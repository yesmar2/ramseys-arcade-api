// The same requests to the old code (8797) and the new (8796), answers compared field by field.
// Usage: node compare.mjs [--count 200] [--seed 7]
const OLD = 'http://127.0.0.1:8797'
const NEW = 'http://127.0.0.1:8796'
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const COUNT = Number(arg('count', 200))
let seed = Number(arg('seed', 7))
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (list) => list[Math.floor(rand() * list.length)]

const GAMES = ['asteroids', 'patriot', 'snake', 'crosswalk', 'stacker', 'centroid', 'pop', 'simon', 'spotter', 'pellets', 'findbug', 'crumbtrail', 'bop', 'putt', 'barrage', 'frenzy', 'fireflies']
const PERIODS = ['daily', 'weekly', 'monthly', 'all']
const WRITERS = Number(arg('writers', 0))
const name = () =>
  rand() < 0.08
    ? pick(['NOBODY', 'lt00001', ''])
    : WRITERS && rand() < 0.4
      ? 'LW' + String(Math.floor(rand() * WRITERS)).padStart(5, '0')
      : 'LT' + String(Math.floor(rand() ** 1.6 * 20000) + 1).padStart(5, '0')

function query() {
  const p = pick(PERIODS)
  const g = pick(GAMES)
  switch (Math.floor(rand() * 7)) {
    case 0: return `/leaderboards/${g}?period=${p}&limit=${pick([1, 25, 100, 500])}&offset=${pick([0, 0, 25, 500, 5000])}${rand() < 0.6 ? `&name=${name()}` : ''}`
    case 1: return `/leaderboards/summary?period=${p}&limit=${pick([3, 10])}`
    case 2: return `/leaderboards/rank?period=${p}&name=${name()}`
    case 3: return `/leaderboards/rank?period=${p}&limit=${pick([5, 10, 100])}&offset=${pick([0, 0, 100, 5000])}`
    case 4: return `/leaderboards/bests?name=${name()}&period=${p}`
    case 5: return `/leaderboards/${g}/qualifies?period=${p}&score=${Math.floor(rand() * 5000)}`
    default: return `/leaderboards/${g}?period=${p}&name=${name()}&limit=1`
  }
}

// JSON with keys in a fixed order, so the same answer reads the same.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v

async function read(base, path) {
  const res = await fetch(base + path)
  const text = await res.text()
  let body
  try {
    body = JSON.stringify(canon(JSON.parse(text)))
  } catch {
    body = text
  }
  return { status: res.status, body, ms: Number(res.headers.get('x-elapsed-ms')) }
}

let same = 0
const differ = []
let oldMs = 0
let newMs = 0
for (let i = 0; i < COUNT; i++) {
  const path = query()
  const [a, b] = await Promise.all([read(OLD, path), read(NEW, path)])
  oldMs += a.ms || 0
  newMs += b.ms || 0
  if (a.status === b.status && a.body === b.body) same++
  else differ.push({ path, old: `${a.status} ${a.body.slice(0, 160)}`, new: `${b.status} ${b.body.slice(0, 160)}` })
}
console.log(`${same}/${COUNT} identical · server time old ${Math.round(oldMs)} ms, new ${Math.round(newMs)} ms`)
for (const d of differ.slice(0, 8)) console.log('DIFF', d.path, '\n  old:', d.old, '\n  new:', d.new)
