// The dailies' answers from two servers on one database, compared whole: their days, day boards, week, month and
// season boards (day points), standings, daily records and course boards. For the day book (store.ts dayBook)
// and the kept course boards (trackLaps.ts), against code from before them.
// Usage: node days-check.mjs [--old http://127.0.0.1:8807] [--new http://127.0.0.1:8806] [--names 12]
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const OLD = arg('old', 'http://127.0.0.1:8807')
const NEW = arg('new', 'http://127.0.0.1:8806')
const NAMES = Number(arg('names', 12))
const AT_ONCE = Number(arg('at-once', 8))

const DAILIES = ['hotlap', 'swoop', 'lander', 'marblerun', 'wobblerun', 'findbug', 'halffull', 'centroid', 'acechase']
const RACES = ['hotlap', 'swoop', 'lander', 'marblerun', 'wobblerun']
const PERIODS = ['daily', 'weekly', 'monthly', 'season']

const get = async (base, path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.text() }
}

// Names to ask as: some from the top of each board, some from deep in it, the crowd's savers, and nobody.
const names = new Set(['NOBODY'])
for (const game of DAILIES) {
  for (const period of ['daily', 'weekly']) {
    const board = JSON.parse((await get(NEW, `/leaderboards/${game}?period=${period}&players=1&limit=500`)).body)
    const rows = board.entries ?? []
    for (let i = 0; i < NAMES && rows.length; i++) names.add(rows[Math.floor((i / NAMES) ** 2 * rows.length)].name)
  }
}
for (let i = 0; i < 6; i++) names.add('SL' + String(i * 37).padStart(5, '0'))
const who = [...names]
console.log(`${who.length} names`)

const paths = []
for (const game of DAILIES) {
  paths.push(`/leaderboards/${game}/days`)
  for (const n of who) paths.push(`/leaderboards/${game}/days?name=${n}`)
  paths.push(`/leaderboards/${game}/daily-records`)
  for (const n of who.slice(0, 8)) paths.push(`/leaderboards/${game}/daily-records?name=${n}`)
  for (const period of PERIODS) {
    paths.push(`/leaderboards/${game}?period=${period}&limit=100`)
    paths.push(`/leaderboards/${game}?period=${period}&players=1&limit=100&offset=100`)
    for (const n of who) paths.push(`/leaderboards/${game}?period=${period}&players=1&name=${n}&limit=10&around=2`)
  }
}
for (const period of PERIODS) {
  paths.push(`/leaderboards/summary?period=${period}&limit=10`)
  for (const n of who) paths.push(`/leaderboards/rank?period=${period}&name=${n}&limit=25`)
}
for (const game of RACES) {
  const list = JSON.parse((await get(NEW, `/tracks/${game}/records`)).body).tracks ?? []
  paths.push(`/tracks/${game}/records`)
  for (const n of who) paths.push(`/tracks/${game}/records?name=${n}`)
  for (const t of list.slice(0, 6)) {
    paths.push(`/tracks/${game}/${t.track}/board?limit=200`)
    for (const n of who.slice(0, 6)) paths.push(`/tracks/${game}/${t.track}/board?name=${n}&limit=3`)
  }
}

let same = 0
const differ = []
for (let i = 0; i < paths.length; i += AT_ONCE) {
  await Promise.all(
    paths.slice(i, i + AT_ONCE).map(async (path) => {
      const t0 = performance.now()
      const [a, b] = await Promise.all([get(OLD, path), get(NEW, path)])
      const ms = performance.now() - t0
      if (ms > 1000) console.log(`slow (${Math.round(ms)} ms): ${path}`)
      if (a.status === b.status && a.body === b.body) same++
      else differ.push({ path, old: `${a.status} ${a.body.slice(0, 300)}`, new: `${b.status} ${b.body.slice(0, 300)}` })
    }),
  )
}
console.log(`${same} of ${paths.length} answers the same`)
for (const d of differ.slice(0, 10)) console.log(`\n${d.path}\n  old: ${d.old}\n  new: ${d.new}`)
process.exit(differ.length ? 1 : 0)
