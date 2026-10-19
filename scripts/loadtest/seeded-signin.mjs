// Sessions for seeded players with the most friends, for reads-check.mjs and saves-check.mjs: their rivals are
// more than themselves. Throwaway database only: it signs in through /auth/magic-link, which only a
// non-production branch answers. Run it before copying a world, so both copies hold the sessions.
//   node seeded-signin.mjs [--base http://127.0.0.1:8806] [--count 5]
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://127.0.0.1:8806')
const COUNT = Number(arg('count', 5))
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55433/arcade_load2'

const emails = execFileSync(
  'psql',
  [DATABASE_URL, '-Atc', `select a.email from accounts a where a.email like '%@seed.skermix.dev' order by (select count(*) from friendships f where f.account_id_a = a.id or f.account_id_b = a.id) desc limit ${COUNT}`],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\r?\n/)
const post = (path, body, ip) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }).then((r) => r.json())
const list = []
for (const [i, email] of emails.entries()) {
  const link = await post('/auth/magic-link', { email }, `10.6.0.${i + 1}`)
  const session = await post('/auth/verify', { token: link.verifyToken }, `10.6.0.${i + 1}`)
  if (!session.sessionToken) throw new Error(`no session for ${email}: ${JSON.stringify(session).slice(0, 200)}`)
  list.push({ name: email.split('@')[0].toUpperCase(), token: session.sessionToken })
}
writeFileSync(new URL('./seeded-accounts.json', import.meta.url), JSON.stringify(list))
console.log(`${list.length} sessions: ${list.map((p) => p.name).join(', ')}`)
