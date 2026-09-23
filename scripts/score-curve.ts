/**
 * Print what each game's rule allows over time.
 *
 * The caps are meant to sit well above real play and well below a forged
 * jackpot, and the only way to know they do is to look at the curve beside the
 * numbers a bot actually scored. Run: `npx tsx scripts/score-curve.ts [game]`.
 */
import { checkScoreRate, rateAllowance } from '../src/scoreLimits.js'
import { ALLOWED_GAMES, type GameSlug } from '../src/store.js'

/** What a bot managed, so the allowance has something honest to be measured against. */
const BOT_BEST: Partial<Record<GameSlug, { score: number; seconds: number }>> = {
  frenzy: { score: 24_463, seconds: 97 },
  barrage: { score: 13_240, seconds: 177 },
  // Taps every tune back the instant it ends: faster than any hand.
  fireflies: { score: 525, seconds: 300 },
}

const only = process.argv[2] as GameSlug | undefined
const games = only ? [only] : [...ALLOWED_GAMES]
const marks = [5, 10, 30, 60, 120, 300]

for (const game of games) {
  if (rateAllowance(game, 1000) == null) continue
  const row = marks
    .map((s) => `${s}s:${Math.round(rateAllowance(game, s * 1000)!).toLocaleString()}`)
    .join('  ')
  console.log(`${game.padEnd(11)} ${row}`)

  const bot = BOT_BEST[game]
  if (bot) {
    const verdict = checkScoreRate(game, bot.score, bot.seconds * 1000)
    const allowed = Math.round(rateAllowance(game, bot.seconds * 1000)!)
    const headroom = (allowed / bot.score).toFixed(1)
    console.log(
      `${' '.repeat(11)} bot ${bot.score.toLocaleString()} in ${bot.seconds}s → ${verdict.ok ? 'allowed' : 'REJECTED'} (${headroom}x headroom)`,
    )
  }
}
