import { seedGame, seedLeaderboards } from './seedBoards.js'
import { seedRecords } from './seedRecords.js'
import { ensureShowcaseTrophies } from './trophies.js'
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
  seedRecords(true)
  ensureShowcaseTrophies()
  console.log('Seeded sample boards + records + showcase trophies')
}
