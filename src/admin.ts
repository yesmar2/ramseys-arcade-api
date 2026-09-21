import type { Request } from 'express'
import { accountFromRequest, type Account } from './auth.js'

/**
 * Who can use the admin tools.
 *
 * Set ADMIN_EMAILS in the environment, comma separated. Unset means nobody,
 * which is the right default: an admin surface that switches itself on when a
 * variable is missing is worse than one that is simply unavailable.
 *
 * The site has its own VITE_ADMIN_EMAILS, but that one only decides which
 * buttons to draw. It grants nothing, because it is read in the browser, where
 * the person being checked is the one doing the checking.
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
