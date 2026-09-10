import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { requireDatabaseUrl } from './client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function migrationsFolder() {
  const candidates = [
    path.resolve(__dirname, '../../drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
  ]
  for (const folder of candidates) {
    if (fs.existsSync(folder)) return folder
  }
  return candidates[0]!
}

/** Apply pending SQL migrations (idempotent). */
export async function runMigrations() {
  const url = requireDatabaseUrl()
  const migrationClient = postgres(url, { max: 1, prepare: false })
  const orm = drizzle(migrationClient)
  try {
    await migrate(orm, { migrationsFolder: migrationsFolder() })
  } finally {
    await migrationClient.end({ timeout: 5 })
  }
}
