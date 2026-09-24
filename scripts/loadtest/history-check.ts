// The ten-minute look at the score and record tables: a small query when nothing
// changed, a fresh read when a script did. Throwaway database only: it inserts
// a row of each kind outside the API's own path. Run with LOG_SQL=1 to see the
// queries.
import postgres from 'postgres'
import { allScores } from '../../src/store.js'
import { getRecordBoard } from '../../src/records.js'

const url = process.env.DATABASE_URL ?? ''
if (!url.includes('127.0.0.1:55432')) throw new Error('throwaway database only')

const realNow = Date.now.bind(Date)
let shift = 0
Date.now = () => realNow() + shift
const later = async (minutes: number) => {
  shift += minutes * 60_000
  await new Promise((r) => setTimeout(r, 1500))
}
const scoreRows = async () => [...(await allScores()).values()].reduce((n, list) => n + list.length, 0)

const outside = postgres(url, { max: 1 })
let problems = 0
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) problems++
}

// Scores.
const first = await allScores()
const before = await scoreRows()
await later(11)
await allScores() // past ten minutes: the look starts, in the background
await later(0)
expect((await allScores()) === first, 'scores: nothing changed, so the copy is kept')
await outside`insert into leaderboard_scores (id, game, name, score, at, device) values (${'check-' + realNow()}, 'snake', 'CHECKER', 7, ${realNow()}, 'desktop')`
await later(11)
await allScores()
await later(0)
const fresh = await allScores()
expect(fresh !== first, 'scores: a row added outside, so the table is read again')
expect((await scoreRows()) === before + 1, 'scores: and the new row is in it')

// Records.
await getRecordBoard('snake', 'play-days-streak', 'all')
await later(11)
await getRecordBoard('snake', 'play-days-streak', 'all')
await later(0)
await outside`insert into record_scores (id, game, record_id, name, score, at, device) values (${'check-' + realNow()}, 'snake', 'play-days-streak', 'CHECKER', 999999, ${realNow()}, 'desktop')`
await later(11)
await getRecordBoard('snake', 'play-days-streak', 'all')
await later(0)
const board = await getRecordBoard('snake', 'play-days-streak', 'all')
expect(board[0]?.name === 'CHECKER', 'records: a record added outside is taken in')

await outside.end()
console.log(problems ? `${problems} problems` : 'all as expected')
process.exit(problems ? 1 : 0)
