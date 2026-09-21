/**
 * End-to-end check of the run-token and rate-limit path.
 *
 * Pure HTTP against a running API, no imports and no database access, so it
 * works against a local server or a deploy: `node scripts/smoke-anticheat.mjs
 * [baseUrl]`. It signs in a throwaway account and claims a throwaway name, so
 * it leaves a handful of junk scores behind — point it at a dev branch.
 */

const BASE = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '')

const TIME_SCORE_BASE = 1_000_000

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function req(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json }
}

function randomTag(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

async function signIn(fixedEmail) {
  const email = fixedEmail ?? `smoke-${randomTag(8).toLowerCase()}@example.com`
  const link = await req('/auth/magic-link', { method: 'POST', body: { email } })
  if (!link.body?.verifyToken) {
    throw new Error(`no verifyToken from /auth/magic-link (status ${link.status})`)
  }
  const verified = await req('/auth/verify', {
    method: 'POST',
    body: { token: link.body.verifyToken },
  })
  if (!verified.body?.sessionToken) {
    throw new Error(`no sessionToken from /auth/verify (status ${verified.status})`)
  }
  return verified.body.sessionToken
}

async function startRun(token, game) {
  const res = await req('/runs/start', { method: 'POST', body: { game }, token })
  return res
}

async function submit(token, game, name, score, runId) {
  return req(`/leaderboards/${game}`, {
    method: 'POST',
    body: { name, score, ...(runId ? { runId } : {}) },
    token,
  })
}

async function main() {
  console.log(`anti-cheat smoke against ${BASE}\n`)

  const health = await req('/health')
  if (health.status !== 200) {
    console.error(`API is not up at ${BASE} (health ${health.status})`)
    process.exit(1)
  }

  const token = await signIn()
  const name = `S${randomTag(7)}`
  console.log(`signed in, playing as ${name}\n`)

  console.log('run tokens')
  const opened = await startRun(token, 'snake')
  check('a run can be opened', opened.status === 201 && Boolean(opened.body?.runId), `status ${opened.status}`)
  const runId = opened.body?.runId

  const jackpot = await submit(token, 'snake', name, 999_999, runId)
  check(
    'an instant jackpot is rejected',
    jackpot.status === 400 && jackpot.body?.code === 'SCORE_IMPLAUSIBLE',
    `status ${jackpot.status} code ${jackpot.body?.code}`,
  )

  const second = await startRun(token, 'snake')
  const honest = await submit(token, 'snake', name, 150, second.body?.runId)
  check('a believable score is saved', honest.status === 201, `status ${honest.status} ${honest.body?.error ?? ''}`)

  const replay = await submit(token, 'snake', name, 150, second.body?.runId)
  check(
    'a spent run cannot be reused',
    replay.status === 400 && replay.body?.code === 'RUN_USED',
    `status ${replay.status} code ${replay.body?.code}`,
  )

  const invented = await submit(token, 'snake', name, 150, 'not-a-real-run-id')
  check(
    'an invented run id is rejected',
    invented.status === 400 && invented.body?.code === 'RUN_UNKNOWN',
    `status ${invented.status} code ${invented.body?.code}`,
  )

  const forOtherGame = await startRun(token, 'snake')
  const crossed = await submit(token, 'crosswalk', name, 20, forOtherGame.body?.runId)
  check(
    "one game's run cannot bank another's score",
    crossed.status === 400 && crossed.body?.code === 'RUN_MISMATCH',
    `status ${crossed.status} code ${crossed.body?.code}`,
  )

  const legacy = await submit(token, 'snake', name, 120, undefined)
  check(
    'a client with no run id still saves (REQUIRE_RUN_TOKEN off)',
    legacy.status === 201,
    `status ${legacy.status} ${legacy.body?.error ?? ''}`,
  )

  // Play first, sign in at the save card: the run is opened by a browser with
  // no session, and the account that appears later has to be able to spend it.
  const signedOut = await req('/runs/start', { method: 'POST', body: { game: 'snake' } })
  check('a signed-out browser can open a run', signedOut.status === 201, `status ${signedOut.status}`)
  const afterSignIn = await submit(token, 'snake', name, 140, signedOut.body?.runId)
  check(
    'signing in afterwards can save that run',
    afterSignIn.status === 201,
    `status ${afterSignIn.status} ${afterSignIn.body?.error ?? ''}`,
  )

  const otherAccount = await signIn()
  const mine = await startRun(token, 'snake')
  const stolen = await submit(otherAccount, 'snake', `S${randomTag(7)}`, 140, mine.body?.runId)
  check(
    "one account cannot spend another's run",
    stolen.status === 400 && stolen.body?.code === 'RUN_MISMATCH',
    `status ${stolen.status} code ${stolen.body?.code}`,
  )

  console.log('\ntime-scored games')
  const fast = await startRun(token, 'findbug')
  const impossibleTime = await submit(token, 'findbug', name, TIME_SCORE_BASE - 30_000, fast.body?.runId)
  check(
    'a 30s run cannot arrive instantly',
    impossibleTime.status === 400 && impossibleTime.body?.code === 'SCORE_IMPLAUSIBLE',
    `status ${impossibleTime.status} code ${impossibleTime.body?.code}`,
  )

  const patient = await startRun(token, 'findbug')
  await sleep(1300)
  const realTime = await submit(token, 'findbug', name, TIME_SCORE_BASE - 1_000, patient.body?.runId)
  check(
    'a run whose clock matches the server is saved',
    realTime.status === 201,
    `status ${realTime.status} ${realTime.body?.error ?? ''}`,
  )

  console.log('\nadmin tools')
  const notAdmin = await req('/admin/whoami', { token })
  check(
    'an ordinary account cannot see the admin tools',
    notAdmin.status === 404,
    `status ${notAdmin.status}`,
  )
  const noSession = await req('/admin/scores')
  check('a stranger cannot see the admin tools', noSession.status === 404, `status ${noSession.status}`)

  const adminEmail = process.env.SMOKE_ADMIN_EMAIL
  if (!adminEmail) {
    console.log('  --   set SMOKE_ADMIN_EMAIL (and ADMIN_EMAILS to match) for the rest')
  } else {
    const adminToken = await signIn(adminEmail)
    const whoami = await req('/admin/whoami', { token: adminToken })
    check(
      'the admin account is recognised',
      whoami.status === 200 && whoami.body?.admin === true,
      `status ${whoami.status}`,
    )

    // A separate player, so banning it cannot disturb the run above.
    const cheatToken = await signIn()
    const cheatName = `C${randomTag(7)}`
    await submit(cheatToken, 'snake', cheatName, 300, undefined)

    const listed = await req(`/admin/scores?name=${cheatName}`, { token: adminToken })
    const victim = listed.body?.scores?.[0]
    check('a score can be looked up with its audit trail', Boolean(victim?.id), `status ${listed.status}`)

    const voided = await req('/admin/scores/void', {
      method: 'POST',
      body: { ids: [victim?.id] },
      token: adminToken,
    })
    check('a score can be voided', voided.body?.voided === 1, `voided ${voided.body?.voided}`)

    const afterVoid = await req(`/admin/scores?name=${cheatName}`, { token: adminToken })
    check('the voided score is off the board', afterVoid.body?.scores?.length === 0)

    await submit(cheatToken, 'snake', cheatName, 310, undefined)
    const banned = await req('/admin/bans', {
      method: 'POST',
      body: { name: cheatName, reason: 'smoke test', purge: true },
      token: adminToken,
    })
    check(
      'a tag can be banned and its scores purged',
      banned.status === 201 && banned.body?.purged?.leaderboard >= 1,
      `status ${banned.status} purged ${JSON.stringify(banned.body?.purged)}`,
    )

    const blocked = await submit(cheatToken, 'snake', cheatName, 320, undefined)
    check(
      'a banned tag cannot post',
      blocked.status === 403 && blocked.body?.code === 'NAME_BANNED',
      `status ${blocked.status} code ${blocked.body?.code}`,
    )

    // The point of recording the account: a new tag must not be a way back on.
    const freshTag = await submit(cheatToken, 'snake', `D${randomTag(7)}`, 330, undefined)
    check(
      'a banned account cannot post under a new tag',
      freshTag.status === 403 && freshTag.body?.code === 'NAME_BANNED',
      `status ${freshTag.status} code ${freshTag.body?.code}`,
    )

    const lifted = await req(`/admin/bans/${cheatName}`, { method: 'DELETE', token: adminToken })
    check('a ban can be lifted', lifted.status === 200, `status ${lifted.status}`)
    const restored = await submit(cheatToken, 'snake', cheatName, 340, undefined)
    check('posting works again after a ban is lifted', restored.status === 201, `status ${restored.status}`)
  }

  console.log('\nrate limiting')
  let limited = null
  for (let i = 0; i < 60; i += 1) {
    const res = await submit(token, 'snake', name, 100 + i, undefined)
    if (res.status === 429) {
      limited = { at: i, body: res.body }
      break
    }
  }
  check(
    'a submission flood is cut off',
    limited !== null && limited.body?.code === 'RATE_LIMITED',
    limited === null ? 'never hit 429 in 60 tries' : `code ${limited.body?.code}`,
  )

  let startLimited = false
  for (let i = 0; i < 200; i += 1) {
    const res = await startRun(token, 'snake')
    if (res.status === 429) {
      startLimited = true
      break
    }
  }
  check('a run-start flood is cut off', startLimited, 'never hit 429 in 200 tries')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
