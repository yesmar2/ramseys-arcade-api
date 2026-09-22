import { pageParams } from './paging.js'
import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { isBanned } from './bans.js'
import { resolveBoardScope } from './groups.js'
import { takeToken } from './rateLimit.js'
import { peekRun } from './runs.js'
import { assertCanUseName, withAvatarId, withAvatarIds } from './names.js'
import {
  addRecord,
  bestRecordForName,
  getRecordBoard,
  getRecordBoardPage,
  getRecordDef,
  listGameRecords,
} from './records.js'
import { siteRecords, siteRecordStandingFor } from './siteRecords.js'
import { isPeriod, resolveGameSlug, type Period } from './store.js'

export const recordsRouter = Router()

const submitSchema = z.object({
  name: z.string().min(1).max(12),
  score: z.number().int().nonnegative().max(3_600_000),
  token: z.string().min(1).max(128).optional(),
  device: z.enum(['phone', 'tablet', 'desktop']).optional(),
  /** Optional until REQUIRE_RUN_TOKEN — older clients do not send one. */
  runId: z.string().min(1).max(64).optional(),
})

/*
 * Record books fill up during a run — a combo lands, a wave clears — so this
 * allows far more than the one score a run posts at the end. It is still a
 * bound: no single game produces hundreds of entries.
 */
const RECORD_SUBMIT_LIMIT = { limit: 120, windowMs: 10 * 60 * 1000 }

const REQUIRE_RUN_TOKEN =
  process.env.REQUIRE_RUN_TOKEN === '1' || process.env.REQUIRE_RUN_TOKEN === 'true'

const RUN_ERRORS: Record<'UNKNOWN' | 'USED' | 'EXPIRED' | 'MISMATCH', string> = {
  UNKNOWN: 'That run is not on record',
  USED: 'That run already saved this record',
  EXPIRED: 'That run is too old to save',
  MISMATCH: 'That run belongs to a different game',
}

/**
 * A stretch of a run cannot be longer than the run.
 *
 * The only plausibility check that holds for every record book without knowing
 * the game: a time recorded inside a run has to fit inside the time the run has
 * been open. Counts get no equivalent — how many combos a second can hold is a
 * per-game question, and a wrong guess there would throw away real play, so
 * they lean on the run, the rate limit and the ban list instead.
 */
function timeRecordFits(def: { unit: string }, score: number, elapsedMs: number): boolean {
  if (def.unit !== 'ms') return true
  return score <= elapsedMs * 1.1
}

function parsePeriod(raw: unknown): Period {
  if (isPeriod(raw)) return raw
  return 'all'
}

async function boardAccess(req: import('express').Request) {
  const account = await accountFromRequest(req)
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const groupId = typeof req.query.group === 'string' ? req.query.group : undefined
  return resolveBoardScope(groupId, { accountId: account?.id, playerName })
}

function scopeError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
  })
}

/*
 * Ahead of '/:game' deliberately: Express takes the first match, and this path
 * would otherwise be read as a request for a game called "site".
 */
recordsRouter.get('/site', async (req, res) => {
  try {
    const scope = await boardAccess(req)
    const name = typeof req.query.name === 'string' ? req.query.name : ''
    res.json({
      boards: await siteRecords(scope),
      you: name ? await siteRecordStandingFor(name, scope) : null,
    })
  } catch (err) {
    scopeError(err, res)
  }
})

recordsRouter.get('/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const period = parsePeriod(req.query.period)
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const { records } = await listGameRecords(game, period, Date.now(), scope)
  // The holder's mark is drawn beside each record, so send their avatar too.
  res.json({
    game,
    period,
    records: await Promise.all(
      records.map(async (r) => ({ ...r, top: r.top ? await withAvatarId(r.top) : r.top })),
    ),
  })
})

recordsRouter.get('/:game/:recordId', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  const recordId = req.params.recordId
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const def = getRecordDef(game, recordId)
  if (!def) {
    res.status(404).json({ error: 'Unknown record' })
    return
  }
  const period = parsePeriod(req.query.period)
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  let scope
  try {
    scope = (await boardAccess(req))?.names
  } catch (err) {
    scopeError(err, res)
    return
  }
  const you = name
    ? await bestRecordForName(game, recordId, name, period, Date.now(), scope)
    : null
  const { limit, offset } = pageParams(req.query)
  const page = await getRecordBoardPage(game, recordId, period, { offset, limit, scope })
  res.json({
    game,
    record: def,
    period,
    offset,
    total: page.total,
    entries: await withAvatarIds(page.entries),
    you: you ? await withAvatarId(you) : null,
  })
})

recordsRouter.post('/:game/:recordId', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  const recordId = req.params.recordId
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  const def = getRecordDef(game, recordId)
  if (!def) {
    res.status(404).json({ error: 'Unknown record' })
    return
  }

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }

  const { name, score, token, device, runId } = parsed.data
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to save a score', code: 'AUTH_REQUIRED' })
    return
  }

  const gate = takeToken(`record:account:${account.id}`, RECORD_SUBMIT_LIMIT)
  if (!gate.ok) {
    res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
    res.status(429).json({ error: 'Too many records too quickly', code: 'RATE_LIMITED' })
    return
  }

  /*
   * The run is read but never claimed. One run fills several books — a combo,
   * a wave time, a streak — so spending it on the first would refuse the rest
   * of the same game.
   */
  if (runId) {
    const run = await peekRun(runId, account.id, game)
    if (!run.ok) {
      res.status(400).json({ error: RUN_ERRORS[run.code], code: `RUN_${run.code}` })
      return
    }
    if (!timeRecordFits(def, score, run.elapsedMs)) {
      console.warn(
        `[anticheat] rejected ${game}/${recordId} of ${score}ms from account ${account.id} after only ${run.elapsedMs}ms`,
      )
      res.status(400).json({
        error: 'That time is longer than the run it came from',
        code: 'RECORD_IMPLAUSIBLE',
      })
      return
    }
  } else if (REQUIRE_RUN_TOKEN) {
    res.status(400).json({ error: 'Start the run before saving a record', code: 'RUN_REQUIRED' })
    return
  }

  let claim: { name: string; token: string }
  try {
    claim = await assertCanUseName(name, {
      claimToken: token,
      accountId: account.id,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Name claim failed',
      code,
    })
    return
  }

  if (await isBanned(claim.name, account.id)) {
    console.log(`[admin] refused a ${game}/${recordId} record from banned ${claim.name}`)
    res.status(403).json({ error: 'This tag cannot post scores', code: 'NAME_BANNED' })
    return
  }

  try {
    const result = await addRecord(game, recordId, claim.name, score, device ?? 'desktop')
    res.status(result.improved ? 201 : 200).json({
      game,
      record: def,
      improved: result.improved,
      entry: result.entry ? await withAvatarId(result.entry) : null,
      rank: result.rank,
      ranks: result.ranks,
      totalEntries: result.totalEntries,
      entries: await withAvatarIds(result.board),
      name: claim.name,
      token: claim.token,
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({
      error: err instanceof Error ? err.message : 'Could not save record',
    })
  }
})
