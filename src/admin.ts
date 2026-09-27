import type { Request } from 'express'
import { accountFromRequest, type Account } from './auth.js'

/**
 * Who can use the admin tools.
 *
 * Set ADMIN_EMAILS in the environment, comma separated. Unset means nobody,
 * which is the right default: an admin surface that switches itself on when a
 * variable is missing is worse than one that is simply unavailable.
 *
 * The site asks GET /admin/whoami to know whether to draw its admin page,
 * menu row and tools, so this list is the only one to keep. (Its old
 * VITE_ADMIN_EMAILS still draws them if it's set, and grants nothing: it's
 * read in the browser, where the person being checked does the checking.)
 */
export function adminEmails(): ReadonlySet<string> {
  return new Set(
    String(process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return adminEmails().has(email.trim().toLowerCase())
}

export type AdminError = Error & { status: number; code: string }

function adminError(message: string, status: number, code: string): AdminError {
  return Object.assign(new Error(message), { status, code })
}

/**
 * The admin behind this request, or a throw.
 *
 * Deliberately answers 404 to a signed-in non-admin: whether this account is
 * an admin is not something a stranger needs confirmed.
 */
export async function requireAdmin(req: Request): Promise<Account> {
  const account = await accountFromRequest(req)
  if (!account) throw adminError('Not found', 404, 'NOT_FOUND')
  if (!isAdminEmail(account.email)) throw adminError('Not found', 404, 'NOT_FOUND')
  return account
}
