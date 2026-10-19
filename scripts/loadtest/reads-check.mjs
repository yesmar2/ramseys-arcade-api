// What the site reads for signed-in players, from two servers, compared field by field (ids and clocks aside):
// Today, its rivals, the day's hole, tickets, secrets and the month's days. As site.mjs's players and visitors,
// and as the seeded players seeded-signin.mjs signed in (they have friends, so their rivals are more than them).
//   node reads-check.mjs [--old http://127.0.0.1:8807] [--new http://127.0.0.1:8806]
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const READS = () => {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return ['/today', '/today/rivals', '/daily-hole', '/tickets', '/secrets/found', `/today/days?month=${month}`]
}
const VOLATILE = new Set(['id', 'at'])

/** Where two answers differ, a line a field, leaving out ids and times. */
export function diff(a, b, path = '') {
  if (typeof a !== typeof b) return [`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`]
  if (a && typeof a === 'object') {
    const out = []
    for (const k of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) if (!VOLATILE.has(k)) out.push(...diff(a[k], b?.[k], `${path}.${k}`))
    return out
  }
  return a === b ? [] : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
}

/** Each of `who`'s reads from both servers. */
export async function compareReads(oldBase, newBase, who) {
  let same = 0
  let n = 0
  const problems = []
  for (const [i, w] of who.entries()) {
    for (const path of READS()) {
      const get = (base) =>
        fetch(base + path, { headers: { authorization: `Bearer ${w.token}`, 'x-forwarded-for': `10.5.${i >> 8}.${i & 255}` } }).then(async (r) => ({ status: r.status, text: await r.text() }))
      const [x, y] = await Promise.all([get(oldBase), get(newBase)])
      n++
      let d = x.status === y.status ? [] : [`status ${x.status} vs ${y.status}`]
      if (!d.length && x.text !== y.text) d = diff(JSON.parse(x.text), JSON.parse(y.text))
      if (!d.length) same++
      else problems.push(`GET ${path} as ${w.name}: ${d.slice(0, 5).join(' · ')}`)
    }
  }
  return { same, n, problems }
}

if (resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : fallback
  }
  const accounts = JSON.parse(readFileSync(new URL('./site-accounts.json', import.meta.url), 'utf8'))
  const seededFile = new URL('./seeded-accounts.json', import.meta.url)
  const seeded = existsSync(seededFile) ? JSON.parse(readFileSync(seededFile, 'utf8')) : []
  // Players site.mjs saves as (300 to 449 with its usual 300 visitors), visitors who never save, and seeded players.
  const who = [...[300, 305, 310, 320, 330, 345, 360, 375, 390, 405, 420, 435, 449, 0, 50, 150, 250].map((i) => accounts[i]).filter(Boolean), ...seeded]
  const { same, n, problems } = await compareReads(arg('old', 'http://127.0.0.1:8807'), arg('new', 'http://127.0.0.1:8806'), who)
  console.log(`${same} of ${n} signed-in reads the same`)
  for (const p of problems.slice(0, 20)) console.log('  ' + p)
  process.exit(problems.length ? 1 : 0)
}
