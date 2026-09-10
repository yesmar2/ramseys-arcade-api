import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

let sqlClient: ReturnType<typeof postgres> | null = null
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      'DATABASE_URL is required. Create a Neon Postgres database and set the pooled connection string.',
    )
  }
  return url
}

function ensurePool() {
  if (sqlClient) return sqlClient
  sqlClient = postgres(requireDatabaseUrl(), {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false,
  })
  return sqlClient
}

export function db() {
  if (dbInstance) return dbInstance
  dbInstance = drizzle(ensurePool(), { schema })
  return dbInstance
}

/** Lightweight connectivity check used by /health. */
export async function checkDbHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      return { ok: false, error: 'DATABASE_URL missing' }
    }
    await db().execute(sql`select 1`)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'database unreachable',
    }
  }
}

export async function closeDb() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 })
    sqlClient = null
    dbInstance = null
  }
}

export type Db = ReturnType<typeof db>
