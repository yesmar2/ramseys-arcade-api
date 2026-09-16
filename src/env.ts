/**
 * Which database this process is pointed at, and whether it is the real one.
 *
 * The local dev server has been running against the production branch, so
 * every destructive path in this codebase — the boot-time wipe, the seed
 * scripts — has been one stray environment variable away from the live
 * leaderboards. Separating the branches is the fix; this is the backstop for
 * when the branch is wrong anyway.
 *
 * It fails safe. An unset NEON_BRANCH reads as production, so a missing
 * variable refuses to wipe rather than assuming it is somewhere harmless.
 */

export type DbTarget = {
  /** Neon branch name as configured, or 'unknown' when nothing says. */
  branch: string
  /** Host of the connection string, for the boot line. Never the credentials. */
  host: string
  isProduction: boolean
}

/** Set this to run a destructive path against production on purpose. */
const OVERRIDE = 'ALLOW_PRODUCTION_WRITES'

function hostOf(url: string | undefined): string {
  if (!url) return 'unset'
  try {
    return new URL(url).host
  } catch {
    return 'unparseable'
  }
}

export function dbTarget(): DbTarget {
  const branch = process.env.NEON_BRANCH?.trim() || ''
  return {
    branch: branch || 'unknown',
    host: hostOf(process.env.DATABASE_URL),
    // Anything that does not name a non-production branch counts as production.
    isProduction: branch === '' || branch === 'production',
  }
}

export function productionWritesAllowed(): boolean {
  const raw = process.env[OVERRIDE]
  return raw === '1' || raw === 'true'
}

/**
 * Refuse a destructive action against production.
 *
 * Returns false rather than throwing at boot, so the server still starts —
 * skipping a wipe is always safer than failing to come up.
 */
export function refuseOnProduction(action: string): boolean {
  const target = dbTarget()
  if (!target.isProduction || productionWritesAllowed()) return false
  console.warn(
    `[db] refused to ${action}: pointed at ${target.branch} (${target.host}). ` +
      `Set NEON_BRANCH to a dev branch, or ${OVERRIDE}=1 to mean it.`,
  )
  return true
}

/** Hard stop for one-shot scripts, where carrying on is not the safe option. */
export function assertNotProduction(action: string): void {
  const target = dbTarget()
  if (!target.isProduction || productionWritesAllowed()) return
  console.error(
    `\n  Refusing to ${action}.\n` +
      `  This process is pointed at branch "${target.branch}" (${target.host}).\n\n` +
      `  Point NEON_BRANCH at a dev branch, or set ${OVERRIDE}=1 if you really\n` +
      `  mean to do this to production.\n`,
  )
  process.exit(1)
}

/** One line at boot naming the database, so it is never a guess. */
export function logDbTarget(): void {
  const target = dbTarget()
  const tag = target.isProduction ? 'PRODUCTION' : target.branch
  console.log(`[db] branch=${tag} host=${target.host}`)
  if (target.isProduction && productionWritesAllowed()) {
    console.warn(`[db] ${OVERRIDE} is set — destructive paths are armed.`)
  }
}
