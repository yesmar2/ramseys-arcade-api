import { Router } from 'express'
import { z } from 'zod'
import { accountFromRequest } from './auth.js'
import { isBanned } from './bans.js'
import { planErrorFields } from './plans.js'
import { assertCanUseName } from './names.js'
import { takeToken } from './rateLimit.js'
import { claimRun, peekRun, runClaimRef, startRun } from './runs.js'
import { checkScoreRate } from './scoreLimits.js'
import { resolveGameSlug, type GameSlug } from './store.js'
import {
  activeTournamentsForGame,
  createTournament,
  getTournamentDetail,
  joinTournament,
  listTournaments,
  renamePlayerAcrossTournaments,
  setTournamentMembersInvite,
  startTournamentTry,
  submitTournamentScore,
  type CreateTournamentInput,
  type TournamentListFilter,
} from './tournaments.js'

export const tournamentsRouter = Router()

/** Whether everyone holding a seat may invite, or only the host. */
const membersInviteSchema = z.object({
  on: z.boolean(),
})

const nameSchema = z.string().min(1).max(12)
const tokenSchema = z.string().min(1).max(128).optional()
const joinSchema = z.object({
  name: nameSchema,
  token: tokenSchema,
  playerId: z.string().min(1).max(64).optional(),
  invite: z.string().min(4).max(16).optional(),
})
const scoreSchema = z.object({
  name: nameSchema,
  game: z.string().min(1),
  score: z.number().int().positive().max(1_000_000),
  token: tokenSchema,
  invite: z.string().min(4).max(16).optional(),
  /** Optional until REQUIRE_RUN_TOKEN — older clients do not send one. */
  runId: z.string().min(1).max(64).optional(),
})

const trySchema = z.object({
  name: nameSchema,
  game: z.string().min(1),
  token: tokenSchema,
  invite: z.string().min(4).max(16).optional(),
})

/** A try a few seconds apart at most, sustained: an event has few tries to spend. */
const TRY_START_LIMIT = { limit: 40, windowMs: 10 * 60 * 1000 }

/*
 * One run fans out to every joined tournament that includes the game, so this
 * allows more than the single board score — but an event is where cheating
 * actually costs somebody something, so it is not generous either.
 */
const TOURNAMENT_SUBMIT_LIMIT = { limit: 60, windowMs: 10 * 60 * 1000 }

const REQUIRE_RUN_TOKEN =
  process.env.REQUIRE_RUN_TOKEN === '1' || process.env.REQUIRE_RUN_TOKEN === 'true'

const RUN_ERRORS: Record<'UNKNOWN' | 'USED' | 'EXPIRED' | 'MISMATCH', string> = {
  UNKNOWN: 'That run is not on record',
  USED: 'That run already scored in this event',
  EXPIRED: 'That run is too old to submit',
  MISMATCH: 'That run belongs to a different game',
}
const renameSchema = z.object({
  from: nameSchema,
  to: nameSchema,
  fromToken: tokenSchema,
  toToken: tokenSchema,
})

const createSchema = z.object({
  title: z.string().min(3).max(60),
  blurb: z.string().max(280).optional(),
  games: z.array(z.string().min(1)).min(1).max(5),
  maxAttempts: z.number().int().min(0).max(99),
  maxPlayers: z.number().int().min(0).max(99),
  durationHours: z.number().int().min(0).max(168),
  roundPlayHours: z.number().int().min(1).max(168).optional(),
  kind: z.enum(['scores', 'bracket']).optional(),
  elimination: z.enum(['single', 'double']).optional(),
  /** Bracket only: one game per winners round, round 1 first. */
  roundGames: z
    .array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(5)]))
    .min(1)
    .max(6)
    .optional(),
})

function claimError(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  const code = (err as { code?: string }).code
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code,
    ...planErrorFields(err),
  })
}

tournamentsRouter.get('/', async (req, res) => {
  const account = await accountFromRequest(req)
  const raw = typeof req.query.source === 'string' ? req.query.source : 'all'
  const filter: TournamentListFilter =
    raw === 'official' || raw === 'mine' || raw === 'joined' ? raw : 'all'
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  res.json({
    tournaments: await listTournaments(Date.now(), filter, account?.id, playerName),
  })
})

tournamentsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to create events' })
    return
  }
  const games: GameSlug[] = []
  for (const game of parsed.data.games) {
    const slug = resolveGameSlug(game)
    if (!slug) {
      res.status(400).json({ error: 'Unknown game' })
      return
    }
    games.push(slug)
  }
  try {
    const input: CreateTournamentInput = {
      title: parsed.data.title,
      blurb: parsed.data.blurb,
      games,
      maxAttempts: parsed.data.maxAttempts,
      maxPlayers: parsed.data.maxPlayers,
      durationHours: parsed.data.durationHours,
      roundPlayHours: parsed.data.roundPlayHours,
      elimination: parsed.data.elimination,
      roundGames: parsed.data.roundGames,
      kind: parsed.data.kind,
    }
    const tournament = await createTournament(input, {
      accountId: account.id,
      email: account.email,
      plan: account.plan,
    })
    res.status(201).json({ tournament })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/rename-player', async (req, res) => {
  const parsed = renameSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = await accountFromRequest(req)
    // Must own the old name; new name must be free or already owned
    await assertCanUseName(parsed.data.from, {
      claimToken: parsed.data.fromToken,
      accountId: account?.id,
    })
    const toClaim = await assertCanUseName(parsed.data.to, {
      claimToken: parsed.data.toToken,
      accountId: account?.id,
    })
    const result = await renamePlayerAcrossTournaments(parsed.data.from, toClaim.name)
    res.json({ ...result, token: toClaim.token, name: toClaim.name })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.get('/active-for/:game', async (req, res) => {
  const game = resolveGameSlug(req.params.game)
  if (!game) {
    res.status(404).json({ error: 'Unknown game' })
    return
  }
  res.json({ game, tournaments: await activeTournamentsForGame(game) })
})

tournamentsRouter.get('/:id', async (req, res) => {
  const playerName =
    typeof req.query.playerName === 'string' ? req.query.playerName : undefined
  const game = typeof req.query.game === 'string' ? req.query.game : undefined
  const inviteCode = typeof req.query.invite === 'string' ? req.query.invite : undefined
  const playerId = typeof req.query.playerId === 'string' ? req.query.playerId : undefined
  const account = await accountFromRequest(req)
  try {
    const detail = await getTournamentDetail(req.params.id, Date.now(), {
      playerName,
      game,
      inviteCode,
      accountId: account?.id,
      playerId,
    })
    if (!detail) {
      res.status(404).json({ error: 'Tournament not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.get('/:id/invites', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in', code: 'AUTH_REQUIRED' })
      return
    }
    const { listTournamentInvitesForHost } = await import('./invites.js')
    const invites = await listTournamentInvitesForHost(req.params.id, account.id)
    res.json({ invites })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/:id/members-invite', async (req, res) => {
  const parsed = membersInviteSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in as the host', code: 'AUTH_REQUIRED' })
      return
    }
    const tournament = await setTournamentMembersInvite(req.params.id, account.id, parsed.data.on)
    res.json({ tournament })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/:id/join', async (req, res) => {
  const parsed = joinSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in to join', code: 'AUTH_REQUIRED' })
      return
    }
    const claim = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account.id,
    })
    const result = await joinTournament(
      req.params.id,
      claim.name,
      Date.now(),
      parsed.data.playerId,
      { inviteCode: parsed.data.invite, accountId: account.id },
    )
    res.status(201).json({ ...result, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})

/*
 * A try begins, and the run it is played in with it. In an event with a set
 * number of tries this is where one is spent: the run handed back is the only
 * one whose score can fill the try, so a run played anywhere else can't stand
 * in for it, and quitting a bad one doesn't give the try back.
 */
tournamentsRouter.post('/:id/attempts', async (req, res) => {
  const parsed = trySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in to play this event', code: 'AUTH_REQUIRED' })
      return
    }
    const gate = takeToken(`tournament-try:account:${account.id}`, TRY_START_LIMIT)
    if (!gate.ok) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
      res.status(429).json({ error: 'Too many tries too quickly', code: 'RATE_LIMITED' })
      return
    }
    const game = resolveGameSlug(parsed.data.game)
    if (!game) {
      res.status(404).json({ error: 'Unknown game', code: 'UNKNOWN_GAME' })
      return
    }
    const claim = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account.id,
    })
    if (await isBanned(claim.name, account.id)) {
      res.status(403).json({ error: 'This tag cannot play events', code: 'NAME_BANNED' })
      return
    }
    const started = await startTournamentTry(req.params.id, claim.name, game, Date.now(), {
      inviteCode: parsed.data.invite,
      accountId: account.id,
    })
    // The run, and the try it's for: its score fills that try and no other.
    const ticket = await startRun(account.id, game)
    await claimRun(ticket.runId, 'attempt', `${req.params.id}:${started.rowId}`)
    res.status(201).json({
      runId: ticket.runId,
      startedAt: ticket.startedAt,
      attempt: started.attempt,
      attemptsUsed: started.attemptsUsed,
      attemptsRemaining: started.attemptsRemaining,
      maxAttempts: started.maxAttempts,
      name: claim.name,
      token: claim.token,
    })
  } catch (err) {
    claimError(err, res)
  }
})

tournamentsRouter.post('/:id/scores', async (req, res) => {
  const parsed = scoreSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() })
    return
  }
  try {
    const account = await accountFromRequest(req)
    if (!account) {
      res.status(401).json({ error: 'Sign in to submit a score', code: 'AUTH_REQUIRED' })
      return
    }
    const gate = takeToken(`tournament:account:${account.id}`, TOURNAMENT_SUBMIT_LIMIT)
    if (!gate.ok) {
      res.setHeader('Retry-After', Math.ceil(gate.retryAfterMs / 1000))
      res.status(429).json({ error: 'Too many scores too quickly', code: 'RATE_LIMITED' })
      return
    }

    /*
     * Same clock check the boards use. Claimed per tournament, so one run can
     * score in every event it qualifies for but only once in each.
     */
    const game = resolveGameSlug(parsed.data.game)
    const { runId, score } = parsed.data
    if (runId && game) {
      const run = await peekRun(runId, account.id, game)
      if (!run.ok) {
        res.status(400).json({ error: RUN_ERRORS[run.code], code: `RUN_${run.code}` })
        return
      }
      const plausible = checkScoreRate(game, score, run.elapsedMs)
      if (!plausible.ok) {
        console.warn(
          `[anticheat] rejected a ${game} tournament score of ${score} from account ${account.id} after ${run.elapsedMs}ms: ${plausible.reason}`,
        )
        res.status(400).json({
          error: 'That score is not possible in the time the run took',
          code: 'SCORE_IMPLAUSIBLE',
        })
        return
      }
    } else if (!runId && REQUIRE_RUN_TOKEN) {
      res.status(400).json({ error: 'Start the run before submitting', code: 'RUN_REQUIRED' })
      return
    }

    const claim = await assertCanUseName(parsed.data.name, {
      claimToken: parsed.data.token,
      accountId: account.id,
    })

    if (await isBanned(claim.name, account.id)) {
      console.log(`[admin] refused a tournament score from banned ${claim.name}`)
      res.status(403).json({ error: 'This tag cannot post scores', code: 'NAME_BANNED' })
      return
    }

    // A run opened as a try in this event fills that try.
    const tryRef = runId ? await runClaimRef(runId, 'attempt') : null
    const tryPrefix = `${req.params.id}:`
    const tryRowId = tryRef?.startsWith(tryPrefix) ? tryRef.slice(tryPrefix.length) : null

    if (runId && !(await claimRun(runId, 'tournament', req.params.id))) {
      res.status(400).json({ error: RUN_ERRORS.USED, code: 'RUN_USED' })
      return
    }

    const result = await submitTournamentScore(
      req.params.id,
      claim.name,
      parsed.data.game,
      parsed.data.score,
      Date.now(),
      { inviteCode: parsed.data.invite, accountId: account.id },
      tryRowId,
    )
    res.status(201).json({ ...result, name: claim.name, token: claim.token })
  } catch (err) {
    claimError(err, res)
  }
})
