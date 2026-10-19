// Every page of the races' day-points boards (the month's and the week's) from two servers, byte for byte, and
// the rows around some tags. days-check.mjs looks at the top of each board and around its names; this reads all
// of it, deep rows included. With skin-runs.sql loaded, it reads around the tags that wear skins too.
//   node board-pages.mjs [--old http://127.0.0.1:8807] [--new http://127.0.0.1:8806]
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const OLD = arg('old', 'http://127.0.0.1:8807')
const NEW = arg('new', 'http://127.0.0.1:8806')
const get = async (base, path) => {
  const res = await fetch(base + path)
  return `${res.status} ${await res.text()}`
}
let same = 0
let n = 0
const differ = []
async function check(path) {
  const [a, b] = await Promise.all([get(OLD, path), get(NEW, path)])
  n++
  if (a === b) same++
  else differ.push(path)
  return b
}
for (const game of ['hotlap', 'swoop', 'lander', 'marblerun']) {
  for (const period of ['monthly', 'weekly']) {
    for (const players of ['', '&players=1']) {
      for (let offset = 0; offset <= 50_000; offset += 500) {
        const body = await check(`/leaderboards/${game}?period=${period}${players}&limit=500&offset=${offset}`)
        if (!JSON.parse(body.slice(4)).entries?.length) break
      }
    }
  }
}
for (let i = 1; i <= 300; i += 7) {
  const tag = 'SKT' + String(i).padStart(3, '0')
  await check(`/leaderboards/hotlap?period=monthly&players=1&name=${tag}&limit=10&around=3`)
  await check(`/leaderboards/bests?name=${tag}&period=monthly`)
}
console.log(`${same} of ${n} board pages the same`)
for (const d of differ.slice(0, 10)) console.log('  DIFF ' + d)
process.exit(differ.length ? 1 : 0)
