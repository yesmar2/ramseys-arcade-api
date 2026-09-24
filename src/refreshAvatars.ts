/*
 * Every saved avatar redrawn in the current format (a2: a monogram or an
 * emblem). The avatars saved before were the seeded world's test data, so
 * they are replaced rather than carried over:
 *
 *   - a seeded tag (its account is `seed-acct-…`) gets a made-up avatar from
 *     the same maker the seed uses, the same one every time for the same tag;
 *   - any other tag goes back to its default, the tag's own monogram, for its
 *     owner to make over in the studio.
 *
 *   npm run avatars:refresh
 *
 * Like the seed, it refuses to touch production unless told to.
 */

import { eq } from 'drizzle-orm'
import { randomAvatarId } from './avatars.js'
import { closeDb, db } from './db/client.js'
import { announceRewrite } from './feed.js'
import { nameClaims } from './db/schema.js'
import { assertNotProduction, dbTarget } from './env.js'

/** A small seeded generator, so a tag's made-up avatar doesn't change from run to run. */
function randFor(name: string) {
  let a = 0
  for (let i = 0; i < name.length; i++) a = (a * 31 + name.charCodeAt(i)) >>> 0
  a = (a ^ 0x9e3779b9) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function main() {
  const target = dbTarget()
  console.log(`Refreshing avatars on ${target.branch || 'an unnamed branch'} (${target.host})`)
  assertNotProduction('refresh every avatar')
  const rows = await db().select({ name: nameClaims.name, accountId: nameClaims.accountId }).from(nameClaims)
  let seeded = 0
  let reset = 0
  for (const row of rows) {
    const isSeeded = row.accountId?.startsWith('seed-acct-') ?? false
    await db()
      .update(nameClaims)
      .set({ avatarId: isSeeded ? randomAvatarId(randFor(row.name)) : null })
      .where(eq(nameClaims.name, row.name))
    if (isSeeded) seeded++
    else reset++
  }
  console.log(`  ${seeded} seeded tags drawn again, ${reset} other tags back to their monogram`)
  // API servers running as more than one read the tags again (feed.ts).
  await announceRewrite(['claims'], { force: true })
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
