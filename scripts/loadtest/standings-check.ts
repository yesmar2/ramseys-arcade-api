// Differential test for the incremental standings: after each save, every
// period's standings must match a count from scratch (the scoped path, with
// everyone in scope). Throwaway database only: it saves scores.
import {
  addScore,
  ALLOWED_GAMES,
  allScores,
  globalRanks,
  PERIODS,
  rankForName,
  type GameSlug,
  type GlobalRankEntry,
} from '../../src/store.js'

if (!process.env.DATABASE_URL?.includes('127.0.0.1:55432')) throw new Error('throwaway database only')

const ROUNDS = Number(process.argv[2] ?? 40)
let seed = Number(process.argv[3] ?? 7)
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]

const names = new Set<string>()
const scoresOf = new Map<GameSlug, number[]>()
for (const [game, entries] of await allScores()) {
  const list: number[] = []
  for (const e of entries) {
    names.add(e.name)
    list.push(e.score)
  }
  scoresOf.set(game as GameSlug, list)
}
const known = [...names]
console.log(`${known.length} players, ${[...scoresOf.values()].reduce((n, l) => n + l.length, 0)} scores`)

function diff(inc: GlobalRankEntry[], ref: GlobalRankEntry[]): string | null {
  if (inc.length !== ref.length) return `length ${inc.length} vs ${ref.length}`
  for (let i = 0; i < inc.length; i++) {
    const a = inc[i]
    const b = ref[i]
    if (a.name !== b.name || a.rank !== b.rank || a.score !== b.score || a.games !== b.games) {
      return `row ${i + 1}: ${JSON.stringify([a.name, a.rank, a.score, a.games])} vs ${JSON.stringify([b.name, b.rank, b.score, b.games])}`
    }
    if (JSON.stringify(a.byGame) !== JSON.stringify(b.byGame)) return `row ${i + 1} byGame differs`
  }
  return null
}

// A count from scratch for each period first, so what follows is patched.
for (const p of PERIODS) await globalRanks(p)

let failures = 0
const cases = { newPlayer: 0, top: 0, middling: 0, low: 0 }
for (let round = 0; round < ROUNDS; round++) {
  const game = pick(ALLOWED_GAMES)
  const fresh = rand() < 0.3
  const name = fresh ? `ZT${String(seed % 100000).padStart(5, '0')}` : pick(known)
  const list = scoresOf.get(game) ?? [0]
  const r = rand()
  // Over the top, somewhere in the field, or low enough not to be anyone's best.
  const score = r < 0.15 ? list[0] + 1 + Math.floor(rand() * 50) : r < 0.75 ? pick(list) : 0
  if (fresh) cases.newPlayer++
  else if (r < 0.15) cases.top++
  else if (r < 0.75) cases.middling++
  else cases.low++
  await addScore(game, name, score, 'desktop')
  names.add(name)
  for (const p of PERIODS) {
    await rankForName(name, 2, p) // waits for a count from after this save
    const inc = await globalRanks(p)
    const ref = await globalRanks(p, Date.now(), names)
    const problem = diff(inc, ref)
    if (problem) {
      failures++
      console.log(`round ${round + 1} ${game} ${name} ${score} ${p}: ${problem}`)
    }
  }
  if ((round + 1) % 10 === 0) console.log(`${round + 1} rounds, ${failures} mismatches`)
}
console.log(`done: ${ROUNDS} saves × ${PERIODS.length} periods, ${failures} mismatches`, cases)
process.exit(failures ? 1 : 0)
