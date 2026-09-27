import type { Request } from 'express'
import { accountFromRequest, type Account } from './auth.js'

/**
 * Who can use the admin tools.
 *
 * Set ADMIN_EMAILS in the environment. Unset means nobody, which is the right
 * default: an admin surface that switches itself on when a variable is
 * missing is worse than one that is simply unavailable.
 *
 * The site asks GET /admin/whoami to know whether to draw its admin page,
 * menu row and tools, so this list is the only one to keep. (Its old
 * VITE_ADMIN_EMAILS still draws them if it's set, and grants nothing: it's
 * read in the browser, where the person being checked does the checking.)
 *
 * The list is every email address in the variable, however it's written:
 * separated by commas, semicolons or spaces, in quotes or <>, or with the
 * whole `ADMIN_EMAILS=…` line pasted in as the value. The variable's name gets
 * the same slack (ADMIN_EMAIL, admin_emails, ADMIN-EMAILS). A dashboard field
 * is an easy place to type any of those, and a list that quietly reads as
 * empty looks exactly like not being an admin.
 */
export function adminEmails(): ReadonlySet<string> {
  const written = Object.entries(process.env)
    .filter(([key]) => ADMIN_KEY.test(key))
    .flatMap(([, value]) => String(value ?? '').match(/[^\s,;"'<>=]+@[^\s,;"'<>]+/g) ?? [])
  return new Set(written.map(mailbox))
}

/** ADMIN_EMAILS, and the near misses of its name. */
const ADMIN_KEY = /^\s*admin[\s_-]*e?mails?\s*$/i

/**
 * The mailbox an address reaches, to compare by: lowercased, and a Gmail
 * address without the dots and +tags Gmail ignores. Google sign-in gives the
 * address the way the account was made, dots and all, which is easy to write
 * another way in the list.
 */
function mailbox(email: string): string {
  const lower = email.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  const domain = lower.slice(at + 1)
  if (at < 1 || (domain !== 'gmail.com' && domain !== 'googlemail.com')) return lower
  return `${lower.slice(0, at).replace(/\+.*$/, '').replace(/\./g, '')}@gmail.com`
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return adminEmails().has(mailbox(email))
}

/**
 * Why an account isn't an admin, null if it is: the API doesn't know the
 * sign-in, or has no admin list at all (ADMIN_EMAILS isn't set where it runs,
 * or has no address in it), or the list doesn't have this account's email.
 * What /admin/whoami tells the one signed in; every other admin route just
 * doesn't exist to them.
 */
export function whyNotAdmin(account: Account | null): { code: string; message: string } | null {
  if (!account) return { code: 'SIGNED_OUT', message: 'The API doesn’t know this sign-in' }
  if (isAdminEmail(account.email)) return null
  if (adminEmails().size === 0) {
    return { code: 'NO_ADMINS', message: 'The API has no admin list: ADMIN_EMAILS isn’t set where it runs' }
  }
  return { code: 'NOT_ADMIN', message: `${account.email} isn’t in the API’s ADMIN_EMAILS` }
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
