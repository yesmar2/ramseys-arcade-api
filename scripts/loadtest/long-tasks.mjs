// The long stretches without idle in a .cpuprofile, and what filled each one.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const minMs = Number(process.argv[3] ?? 300)
const p = JSON.parse(readFileSync(file, 'utf8'))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const name = (n) => n.callFrame.functionName || '(anon)'
const where = (n) => {
  const url = n.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/')
  return url.startsWith('src/') ? `${name(n)} ${url.replace(/^src\//, '')}` : null
}

let t = p.startTime
const tasks = []
let cur = null
for (let i = 0; i < p.samples.length; i++) {
  t += p.timeDeltas[i] ?? 0
  const node = byId.get(p.samples[i])
  const idle = name(node) === '(idle)'
  if (idle) {
    if (cur && (cur.end - cur.start) / 1000 >= minMs) tasks.push(cur)
    cur = null
    continue
  }
  if (!cur) cur = { start: t, end: t, stacks: new Map() }
  cur.end = t
  // What was on the stack, our code only, each function counted once per sample.
  const seen = new Set()
  let id = p.samples[i]
  while (id != null) {
    const w = where(byId.get(id))
    if (w && !seen.has(w)) {
      seen.add(w)
      cur.stacks.set(w, (cur.stacks.get(w) ?? 0) + (p.timeDeltas[i] ?? 0))
    }
    id = parent.get(id)
  }
  if (name(node) === '(garbage collector)') cur.stacks.set('(gc)', (cur.stacks.get('(gc)') ?? 0) + (p.timeDeltas[i] ?? 0))
}
console.log(`${tasks.length} busy stretches of ${minMs} ms or more`)
for (const task of tasks.slice(0, 25)) {
  const ms = Math.round((task.end - task.start) / 1000)
  const at = Math.round((task.start - p.startTime) / 1e6)
  const top = [...task.stacks]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w, us]) => `${w} ${Math.round(us / 1000)}`)
  console.log(`+${at}s ${ms} ms: ${top.join(' · ')}`)
}
