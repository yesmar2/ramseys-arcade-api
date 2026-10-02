/**
 * Sending email, through Resend's web API: a plain HTTPS call, because Render's free services can't
 * reach mail servers directly (SMTP ports are closed there).
 *
 * RESEND_API_KEY and EMAIL_FROM ("Blipka <codes@your-domain>") turn it on. Resend sends from a domain
 * you've verified with it; until there is one, it only delivers to the address the Resend account
 * signed up with, which is fine for trying it but not for players.
 */

const RESEND_URL = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 10_000

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

export async function sendMail(message: {
  to: string
  subject: string
  text: string
  html: string
}): Promise<void> {
  const key = resendKey()
  const from = fromAddress()
  if (!key || !from) {
    throw Object.assign(new Error('Email isn’t set up here'), { status: 503, code: 'EMAIL_NOT_CONFIGURED' })
  }
  let res: Response
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (err) {
    console.error('[mail] send failed:', err instanceof Error ? err.message : err)
    throw Object.assign(new Error('Couldn’t send the email. Try again in a moment.'), { status: 502, code: 'EMAIL_SEND_FAILED' })
  }
  if (!res.ok) {
    // Resend says why (a domain not verified yet, the day's quota, ...): the log keeps it, the player gets the short version.
    const why = await res.text().catch(() => '')
    console.error(`[mail] Resend answered ${res.status}: ${why.slice(0, 300)}`)
    throw Object.assign(new Error('Couldn’t send the email. Try again in a moment.'), { status: 502, code: 'EMAIL_SEND_FAILED' })
  }
}
