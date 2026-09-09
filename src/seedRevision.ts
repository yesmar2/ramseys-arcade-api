import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { replaceAllRecords } from './records.js'
import { replaceAllBoards } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const REV_PATH = path.join(DATA_DIR, '.seed-rev')

/**
 * Bump this to wipe leaderboards/records/trophies on the next API boot.
 * Keeps accounts, sessions, and name claims. Does not re-add sample scores.
 */
export const SEED_REVISION = '2026-09-09-clear-for-testing'

function readRev(): string | null {
  try {
    if (!fs.existsSync(REV_PATH)) return null
    return fs.readFileSync(REV_PATH, 'utf8').trim() || null
  } catch {
    return null
  }
}

function writeRev(rev: string) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(REV_PATH, `${rev}\n`)
}

function clearTrophies() {
  const trophiesPath = path.join(DATA_DIR, 'trophies.json')
  try {
    fs.writeFileSync(
      trophiesPath,
      JSON.stringify({ awards: [], cursor: {} }, null, 2),
    )
  } catch {
    /* ignore */
  }
}

function clearBoardsAndRecords() {
  replaceAllBoards({
    stacker: [],
    patriot: [],
    snake: [],
    pop: [],
    centroid: [],
    asteroids: [],
    simon: [],
    crosswalk: [],
    spotter: [],
    stride: [],
    pellets: [],
  })
  replaceAllRecords({})
  clearTrophies()
}

/** Wipe sample boards when {@link SEED_REVISION} changes (or SEED_FORCE). */
export function applySeedRevision(forceEnv = false): boolean {
  const force = forceEnv || process.env.SEED_FORCE === '1' || process.env.SEED_FORCE === 'true'
  const current = readRev()
  if (!force && current === SEED_REVISION) return false

  clearBoardsAndRecords()
  writeRev(SEED_REVISION)
  return true
}
