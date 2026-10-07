/*
 * Centroid's day plan and scoring live twice: in the site (ramseys-arcade/src/games/dead-center) and here
 * (src/centroid, copied by scripts/copy-centroid.py), and the API checks a player's score by dealing the day
 * again. This deals a year and a half of days both ways and scores a spread of taps on each, and fails on
 * any difference, to the bit. It also fails when the two sides differ on the first day or the day it joined
 * the Dailies.
 *
 * Run from this repo with the site checked out beside it: `npm run check:centroid`.
 */
import { CENTROID_FIRST_DAY, CENTROID_TODAY_FROM } from '../src/centroid/launch.js'
import * as apiPlan from '../src/centroid/plan.js'
import * as apiScore from '../src/centroid/score.js'
import * as webPlan from '../../ramseys-arcade/src/games/dead-center/plan.js'
import * as webScore from '../../ramseys-arcade/src/games/dead-center/score.js'
import { FIRST_DAY as WEB_FIRST_DAY, TODAY_FROM as WEB_TODAY_FROM } from '../../ramseys-arcade/src/games/dead-center/daily.js'

if (CENTROID_FIRST_DAY !== WEB_FIRST_DAY) {
  console.error(`Centroid's first day is ${CENTROID_FIRST_DAY} here and ${WEB_FIRST_DAY} on the site.`)
  process.exit(1)
}
if (CENTROID_TODAY_FROM !== WEB_TODAY_FROM) {
  console.error(`Today's Plates joins the Dailies on ${CENTROID_TODAY_FROM ?? 'not set'} here and ${WEB_TODAY_FROM ?? 'not set'} on the site.`)
  process.exit(1)
}
const DAYS = Number(process.argv[2] ?? 540)

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

let seed = 7
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

let bad = 0
for (let i = 0; i < DAYS; i++) {
  const day = addDays(CENTROID_FIRST_DAY, i)
  const a = apiPlan.dayPlan(day)
  const b = webPlan.dayPlan(day)
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`${day}: the plates differ`)
    bad++
    continue
  }
  for (let k = 0; k < 4; k++) {
    // Taps round each plate's balance point, near and far, and one off the plate.
    const taps = a.plates.map((p) => ({
      x: Math.round((p.centroid.x + (rand() - 0.5) * p.size * (k + 1) * 0.15) * 1e4) / 1e4,
      y: Math.round((p.centroid.y + (rand() - 0.5) * p.size * (k + 1) * 0.15) * 1e4) / 1e4,
    }))
    const ja = apiScore.judgeTaps(a, taps)
    const jb = webScore.judgeTaps(b, taps)
    if (JSON.stringify(ja) !== JSON.stringify(jb)) {
      console.error(`${day}: taps ${k} score ${ja.board} here and ${jb.board} on the site`)
      bad++
    }
  }
}
if (bad) {
  console.error(`${bad} difference(s) in ${DAYS} days`)
  process.exit(1)
}
console.log(`Centroid: ${DAYS} days from ${CENTROID_FIRST_DAY} deal and score the same here and on the site.`)
