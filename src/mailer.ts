/**
 * Sending email, through Resend's web API: a plain HTTPS call, because Render's free services can't
 * reach mail servers directly (SMTP ports are closed there).
 *
 * RESEND_API_KEY and EMAIL_FROM ("Blipka <codes@your-domain>") turn it on. Resend sends from a domain
 * you've verified with it; until there is one, it only delivers to the address the Resend account
 * signed up with, which is fine for trying it but not for players.
 */

const RESEND_URL = 'https://api.resend.com/emails'
const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch'
const SEND_TIMEOUT_MS = 10_000
const BATCH_TIMEOUT_MS = 30_000

function resendKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null
}

function fromAddress(): string | null {
  return process.env.EMAIL_FROM?.trim() || null
}

/** Whether this server can send mail at all. */
export function mailerReady(): boolean {
  return Boolean(resendKey() && fromAddress())
}

export type Mail = {
  to: string
  subject: string
  text: string
  html: string
}

export async function sendMail(message: Mail): Promise<void> {
  const why = await postToResend(RESEND_URL, (from) => mailBody(from, message), SEND_TIMEOUT_MS)
  // The log keeps what Resend said; the player gets the short version.
  if (why) throw Object.assign(new Error('Couldn’t send the email. Try again in a moment.'), { status: 502, code: 'EMAIL_SEND_FAILED' })
}

/** Resend's batch API takes up to this many emails a call. */
export const BATCH_MAX = 100

/**
 * Up to BATCH_MAX emails in one call to Resend's batch API, which sends all of them or none. For an admin's send
 * (the launch list's), so a refusal says what Resend said: a domain not verified yet, the day's quota.
 */
export async function sendMailBatch(messages: Mail[]): Promise<void> {
  if (!messages.length) return
  if (messages.length > BATCH_MAX) throw new Error(`At most ${BATCH_MAX} emails a batch`)
  const why = await postToResend(RESEND_BATCH_URL, (from) => messages.map((m) => mailBody(from, m)), BATCH_TIMEOUT_MS)
  if (why) throw Object.assign(new Error(`Resend didn’t send them: ${why}`), { status: 502, code: 'EMAIL_SEND_FAILED' })
}

function mailBody(from: string, message: Mail) {
  return { from, to: [message.to], subject: message.subject, text: message.text, html: message.html }
}

/** Hands Resend the body built for this sender; null when it took the mail, otherwise why not. */
async function postToResend(url: string, body: (from: string) => unknown, timeoutMs: number): Promise<string | null> {
  const key = resendKey()
  const from = fromAddress()
  if (!key || !from) {
    throw Object.assign(new Error('Email isn’t set up here'), { status: 503, code: 'EMAIL_NOT_CONFIGURED' })
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body(from)),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    console.error('[mail] send failed:', err instanceof Error ? err.message : err)
    return 'it couldn’t be reached'
  }
  if (res.ok) return null
  const said = await res.text().catch(() => '')
  console.error(`[mail] Resend answered ${res.status}: ${said.slice(0, 300)}`)
  try {
    const message = (JSON.parse(said) as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    /* not JSON: the status is all there is */
  }
  return `it answered ${res.status}`
}
