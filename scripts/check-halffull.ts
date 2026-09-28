/*
 * Half Full's day plan and scoring live twice: in the site (ramseys-arcade/src/games/halffull) and here
 * (src/halffull), and the API checks a player's score by building the day again. This builds a year and
 * a half of days both ways and scores a spread of pours on each, and fails on any difference, to the bit.
 *
 * Run from this repo with the site checked out beside it: `npm run check:halffull`.
 */
import { HALFFULL_FIRST_DAY } from '../src/halffull/launch.js'
import * as apiPlan from '../src/halffull/plan.js'
import * as apiScore from '../src/halffull/score.js'
import * as webPlan from '../../ramseys-arcade/src/games/halffull/plan.js'
import * as webScore from '../../ramseys-arcade/src/games/halffull/score.js'
import { FIRST_DAY as WEB_FIRST_DAY } from '../../ramseys-arcade/src/games/halffull/daily.js'

// Half Full #1 is one day on both sides: the board and the book count from it, and the site numbers from it.
if (HALFFULL_FIRST_DAY !== WEB_FIRST_DAY) {
  console.error(`Half Full's first day is ${HALFFULL_FIRST_DAY} here and ${WEB_FIRST_DAY} on the site.`)
  process.exit(1)
}
const FIRST = HALFFULL_FIRST_DAY
const DAYS = Number(process.argv[2] ?? 540)

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Everything a day's play depends on, as text, so two plans compare exactly. */
function shape(p: ReturnType<typeof apiPlan.dayPlan>): string {
  const glass = (g: (typeof p.pours)[number]) => [g.family, g.name, g.aspect, g.r, g.half]
  const s = p.split
  return JSON.stringify([
    p.day,
    p.label,
    p.pours.map(glass),
    p.refs,
    glass(s.A),
    glass(s.B),
    [s.sizeA, s.sizeB, s.J, s.lo, s.hi, s.fairA, s.start, s.ref],
    p.looks,
  ])
}

let seed = 7
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

let bad = 0
let pours = 0
for (let i = 0; i < DAYS; i++) {
  const day = addDays(FIRST, i)
  const a = apiPlan.dayPlan(day)
  const w = webPlan.dayPlan(day)
  if (shape(a) !== shape(w as unknown as typeof a)) {
    bad++
    if (bad <= 5) console.error(`${day}: the plans differ`)
    continue
  }
  // Ten runs a day: the exact answers, the ends, and random pours.
  for (let run = 0; run < 10; run++) {
    const levels = [0, 1, 2, 3].map((round) =>
      run === 0 ? Math.round(a.pours[round]!.half) : run === 1 ? 0 : run === 2 ? 1000 : Math.floor(rand() * 1001),
    )
    const s = a.split
    levels.push(run === 0 ? Math.round(s.fairA) : run === 1 ? s.lo : run === 2 ? s.hi : s.lo + Math.floor(rand() * (s.hi - s.lo + 1)))
    const ja = apiScore.judgeLevels(a, levels)
    const jw = webScore.judgeLevels(w, levels)
    pours += 5
    if (JSON.stringify(ja) !== JSON.stringify(jw) || apiScore.levelsFit(a, levels) !== webScore.levelsFit(w, levels)) {
      bad++
      if (bad <= 5) console.error(`${day}: ${JSON.stringify(levels)} scores differently`)
    }
  }
}
if (bad) {
  console.error(`Half Full: ${bad} difference(s) between the site and the API.`)
  process.exit(1)
}
console.log(`Half Full: ${DAYS} days and ${pours} pours the same on the site and the API.`)
