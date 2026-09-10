import fs from 'node:fs'

const p = 'C:/Users/ramse/code/ramseys-arcade-api/src/tournaments.ts'
let s = fs.readFileSync(p, 'utf8')

// Replace fs imports with drizzle
s = s.replace(
  `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
`,
  `import { eq, inArray } from 'drizzle-orm'
import { db } from './db/client.js'
import { tournaments as tournamentsTable } from './db/schema.js'
`,
)

s = s.replace(
  `const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'tournaments.json')

`,
  '',
)

const ensureStart = s.indexOf('function emptyStore(now = Date.now()): Store {')
const putStart = s.indexOf('/** Put a normalized copy back so score-array replacements persist. */')
if (ensureStart < 0 || putStart < 0) throw new Error('markers not found')

const replacement = `function emptyStore(now = Date.now()): Store {
  return { tournaments: [buildDailyEvent(now), buildWeeklyEvent(now)] }
}

function tournamentToRow(t: Tournament) {
  return {
    id: t.id,
    data: t as unknown as Record<string, unknown>,
    official: Boolean(t.official),
    cadence: t.cadence ?? null,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    visibility: t.visibility ?? (t.official ? 'public' : 'private'),
    inviteCode: t.inviteCode ?? null,
  }
}

async function writeStore(store: Store) {
  const list = store.tournaments.map(normalizeTournament)
  await db().transaction(async (tx) => {
    const existing = await tx.select({ id: tournamentsTable.id }).from(tournamentsTable)
    const nextIds = new Set(list.map((t) => t.id))
    const toDelete = existing.map((r) => r.id).filter((id) => !nextIds.has(id))
    if (toDelete.length) {
      await tx.delete(tournamentsTable).where(inArray(tournamentsTable.id, toDelete))
    }
    for (const t of list) {
      const row = tournamentToRow(t)
      await tx
        .insert(tournamentsTable)
        .values(row)
        .onConflictDoUpdate({
          target: tournamentsTable.id,
          set: {
            data: row.data,
            official: row.official,
            cadence: row.cadence,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            visibility: row.visibility,
            inviteCode: row.inviteCode,
          },
        })
    }
  })
}

async function ensureStore(now = Date.now()): Promise<Store> {
  const rows = await db().select().from(tournamentsTable)
  let store: Store
  if (rows.length === 0) {
    store = emptyStore(now)
    await writeStore(store)
    return store
  }
  store = {
    tournaments: rows.map((r) => normalizeTournament(r.data as Tournament)),
  }
  let migrated = false
  for (const t of store.tournaments) {
    if (t.createdBy && !t.official && t.visibility !== 'private') {
      t.visibility = 'private'
      migrated = true
    }
    if (t.visibility === 'private' && t.createdBy && !t.inviteCode) {
      t.inviteCode = generateInviteCode()
      migrated = true
    }
  }
  if (migrated) await writeStore(store)
  if (ensureRollingEvents(store, now)) await writeStore(store)
  return store
}

`

s = s.slice(0, ensureStart) + replacement + s.slice(putStart)

// Make ensureStore/writeStore callers await and exports async
const asyncExports = [
  'listTournaments',
  'getTournament',
  'getTournamentPlayerStatus',
  'getTournamentDetail',
  'createTournament',
  'joinTournament',
  'submitTournamentScore',
  'activeTournamentsForGame',
  'renamePlayerAcrossTournaments',
]

for (const name of asyncExports) {
  s = s.replace(new RegExp(`export function ${name}\\b`, 'g'), `export async function ${name}`)
}

// await ensureStore and writeStore
s = s.replace(/([^=])ensureStore\(/g, '$1await ensureStore(')
s = s.replace(/([^a])writeStore\(/g, '$1await writeStore(')
// fix double await
s = s.replace(/await await /g, 'await ')

// ensureRollingEvents may need to stay sync (mutates store in memory)
// withAvatarIds is now async in names - need await
s = s.replace(/withAvatarIds\(/g, 'await withAvatarIds(')
s = s.replace(/await await withAvatarIds\(/g, 'await withAvatarIds(')

fs.writeFileSync(p, s)
console.log('tournaments transformed', fs.statSync(p).size)
