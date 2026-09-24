// Summarize a .cpuprofile: self and inclusive time per function, heaviest first.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const top = Number(process.argv[3] ?? 40)
const p = JSON.parse(readFileSync(file, 'utf8'))

const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const selfUs = new Map()
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i]
  selfUs.set(id, (selfUs.get(id) ?? 0) + (p.timeDeltas[i] ?? 0))
}
const total = [...selfUs.values()].reduce((a, b) => a + b, 0)

const label = (n) => {
  const f = n.callFrame
  const url = f.url ? f.url.replace(/^.*\/(src|node_modules)\//, '$1/') : ''
  return `${f.functionName || '(anon)'} ${url}${url ? ':' + (f.lineNumber + 1) : ''}`
}

const self = new Map()
const incl = new Map()
for (const [id, us] of selfUs) {
  const n = byId.get(id)
  self.set(label(n), (self.get(label(n)) ?? 0) + us)
  // Inclusive: count once per distinct function on the stack.
  const seen = new Set()
  let cur = id
  while (cur != null) {
    const l = label(byId.get(cur))
    if (!seen.has(l)) {
      seen.add(l)
      incl.set(l, (incl.get(l) ?? 0) + us)
    }
    cur = parent.get(cur)
  }
}

const pct = (us) => ((100 * us) / total).toFixed(1).padStart(5) + '%'
console.log(`total ${(total / 1e6).toFixed(1)} s sampled`)
console.log('\n--- self ---')
for (const [l, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(pct(us), l)
console.log('\n--- inclusive (src/ only) ---')
for (const [l, us] of [...incl].filter(([l]) => l.includes(' src/')).sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(pct(us), l)
