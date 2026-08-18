import { seedGame, seedLeaderboards } from './seedBoards.js'
import { isAllowedGame } from './store.js'

const game = process.argv[2]
if (game) {
  if (!isAllowedGame(game)) {
    console.error(`Unknown game: ${game}`)
    process.exit(1)
  }
  seedGame(game)
  console.log(`Seeded ${game} leaderboard`)
} else {
  seedLeaderboards(true)
  console.log('Seeded leaderboards with sample arcade scores')
}
