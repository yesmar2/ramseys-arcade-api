import { seedGame } from './seedBoards.js'
import { applySeedRevision, SEED_REVISION } from './seedRevision.js'
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
  applySeedRevision(true)
  console.log(`Reseeded boards + records (rev ${SEED_REVISION})`)
}
