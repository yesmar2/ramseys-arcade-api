// The time-span period filter against the day-key one (inPeriod): real runs, and runs
// a millisecond either side of every quarter hour across daylight-saving changes,
// month ends and a year end. Throwaway database only (it reads the score history).
import { allScores, filterByPeriod, inPeriod, PERIODS, type LeaderboardEntry } from '../../src/store.js'

const Q = 15 * 60_000
let checks = 0
let mismatches = 0

function compare(label: string, entries: LeaderboardEntry[], now: number) {
  for (const period of PERIODS) {
    const fast = filterByPeriod(entries, period, now)
    const slow = entries.filter((e) => inPeriod(e.at, period, now))
    checks++
    if (fast.length !== slow.length || fast.some((e, i) => e !== slow[i])) {
      mismatches++
      console.log(`MISMATCH ${label} ${period} at ${new Date(now).toISOString()}: ${fast.length} vs ${slow.length}`)
    }
  }
}

// Real runs, asked about at a few moments.
const snake = (await allScores()).get('snake') as LeaderboardEntry[]
for (const now of [Date.now(), Date.now() - 3 * 86400_000, Date.now() - 20 * 86400_000]) compare('snake', snake, now)

// Synthetic runs a millisecond either side of every quarter hour, over spans that
// take in month ends, week starts and both daylight-saving changes of 2026.
function around(fromIso: string, days: number) {
  const out: LeaderboardEntry[] = []
  const from = Date.parse(fromIso)
  for (let t = from; t < from + days * 86400_000; t += Q) {
    for (const at of [t - 1, t, t + 1]) out.push({ id: String(at), name: 'X', score: 1, at, device: 'desktop' })
  }
  return out
}
for (const [label, fromIso] of [
  ['spring forward', '2026-03-05T00:00:00Z'],
  ['fall back', '2026-10-29T00:00:00Z'],
  ['month end', '2026-09-27T00:00:00Z'],
  ['year end', '2026-12-28T00:00:00Z'],
] as const) {
  const runs = around(fromIso, 8)
  const from = Date.parse(fromIso)
  // Asked at every hour across the span, and a millisecond either side of each.
  for (let now = from; now < from + 8 * 86400_000; now += 3600_000) {
    compare(label, runs, now - 1)
    compare(label, runs, now)
  }
}
console.log(`${checks} checks, ${mismatches} mismatches`)
process.exit(mismatches ? 1 : 0)
