import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedLeaderboards } from './seedBoards.js'
import { seedRecords } from './seedRecords.js'
import { ensureShowcaseTrophies } from './trophies.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const REV_PATH = path.join(DATA_DIR, '.seed-rev')

/**
 * Bump this to wipe + reseed leaderboards/records on the next API boot.
 * Keeps accounts, sessions, and name claims.
 */
export const SEED_REVISION = '2026-09-04-stacker-perfect'

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

/** Force-refresh sample boards when {@link SEED_REVISION} changes (or SEED_FORCE). */
export function applySeedRevision(forceEnv = false): boolean {
  const force = forceEnv || process.env.SEED_FORCE === '1' || process.env.SEED_FORCE === 'true'
  const current = readRev()
  if (!force && current === SEED_REVISION) return false

  seedLeaderboards(true)
  seedRecords(true)
  clearTrophies()
  writeRev(SEED_REVISION)
  return true
}
