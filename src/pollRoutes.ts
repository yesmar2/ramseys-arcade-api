import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from './admin.js'
import { accountFromRequest } from './auth.js'
import { adminPolls, answerPastPoll, answerPoll, editPoll, movePoll, pastPolls, pollView, removePoll, resetPoll } from './poll.js'
import { takeToken } from './rateLimit.js'

/*
 * Blip's question of the day (poll.ts): anyone can see it and yesterday's result, a signed-in player answers
 * it, and an admin edits, moves and takes out the questions to come.
 */
export const pollRouter = Router()

/** More answers than anyone gives; only a script would. */
const ANSWER_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 }
/** Catching up on a backlog of past questions takes more, one tap each. */
const PAST_ANSWER_LIMIT = { limit: 60, windowMs: 10 * 60 * 1000 }

function fail(err: unknown, res: import('express').Response) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({
    error: err instanceof Error ? err.message : 'Request failed',
    code: (err as { code?: string }).code,
  })
}

/** Today's question, with your answer and everyone's once you've given yours, and yesterday's result. */
pollRouter.get('/', async (req, res) => {
  try {
    const account = await accountFromRequest(req)
    res.setHeader('Cache-Control', 'no-store')
    res.json(await pollView(account?.id ?? null))
  } catch (err) {
    fail(err, res)
  }
})

const pastSchema = z.object({
  before: z.coerce.number().int().min(2).optional(),
  count: z.coerce.number().int().min(1).max(60).optional(),
})

/** The questions before today's, newest first, each with how everyone answered and yours: Blip's questions page. */
pollRouter.get('/past', async (req, res) => {
  const parsed = pastSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', code: 'INVALID_QUERY' })
    return
  }
  try {
    const account = await accountFromRequest(req)
    res.setHeader('Cache-Control', 'no-store')
    res.json(await pastPolls(account?.id ?? null, parsed.data.before ?? null, parsed.data.count ?? 20))
  } catch (err) {
    fail(err, res)
  }
})

const answerSchema = z.object({ pick: z.number().int().min(0).max(9) })

/** Answer today's question: signed in, once a day. */
pollRouter.post('/', async (req, res) => {
  const parsed = answerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Pick an answer', code: 'INVALID_BODY' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to answer Blip', code: 'AUTH_REQUIRED' })
    return
  }
  if (!takeToken(`poll:${account.id}`, ANSWER_LIMIT).ok) {
    res.status(429).json({ error: 'Slow down a little', code: 'RATE_LIMITED' })
    return
  }
  try {
    res.json(await answerPoll(account.id, parsed.data.pick))
  } catch (err) {
    fail(err, res)
  }
})

/** Answer a past question, late: signed in, once each, for no tickets (poll.ts answerPastPoll). */
pollRouter.post('/past/:n', async (req, res) => {
  const n = Number(req.params.n)
  const parsed = answerSchema.safeParse(req.body)
  if (!Number.isInteger(n) || n < 1 || !parsed.success) {
    res.status(400).json({ error: 'Pick an answer', code: 'INVALID_BODY' })
    return
  }
  const account = await accountFromRequest(req)
  if (!account) {
    res.status(401).json({ error: 'Sign in to answer Blip', code: 'AUTH_REQUIRED' })
    return
  }
  if (!takeToken(`poll-past:${account.id}`, PAST_ANSWER_LIMIT).ok) {
    res.status(429).json({ error: 'Slow down a little', code: 'RATE_LIMITED' })
    return
  }
  try {
    res.json({ poll: await answerPastPoll(account.id, n, parsed.data.pick) })
  } catch (err) {
    fail(err, res)
  }
})

const listSchema = z.object({
  from: z.coerce.number().int().min(1).optional(),
  count: z.coerce.number().int().min(1).max(120).optional(),
})

/** The questions from a day on (today's, by default), for /admin, and how many there are before they come round. */
pollRouter.get('/admin', async (req, res) => {
  const parsed = listSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', code: 'INVALID_QUERY' })
    return
  }
  try {
    await requireAdmin(req)
    res.json(await adminPolls(parsed.data.from ?? null, parsed.data.count ?? 30))
  } catch (err) {
    fail(err, res)
  }
})

const editSchema = z.object({
  q: z.string().trim().min(3).max(90),
  options: z.array(z.string().trim().min(1).max(24)).min(2).max(4),
})

/** Edit a day's question: today's or one to come, never a past one (its answers are in). */
pollRouter.put('/admin/:n', async (req, res) => {
  const n = Number(req.params.n)
  const parsed = editSchema.safeParse(req.body)
  if (!Number.isInteger(n) || n < 1 || !parsed.success) {
    res.status(400).json({ error: 'A question and two to four short answers', code: 'INVALID_BODY' })
    return
  }
  try {
    await requireAdmin(req)
    res.json({ poll: await editPoll(n, parsed.data.q, parsed.data.options) })
  } catch (err) {
    fail(err, res)
  }
})

/** Put a day's question back to the plan's: today's or one to come. */
pollRouter.delete('/admin/:n', async (req, res) => {
  const n = Number(req.params.n)
  if (!Number.isInteger(n) || n < 1) {
    res.status(400).json({ error: 'Which day?', code: 'INVALID_BODY' })
    return
  }
  try {
    await requireAdmin(req)
    res.json({ poll: await resetPoll(n) })
  } catch (err) {
    fail(err, res)
  }
})

const moveSchema = z.object({ by: z.union([z.literal(-1), z.literal(1)]), count: z.number().int().min(1).max(120).optional() })

/** Move a question to come a day sooner or later, swapping with that day's. Answers with the list from today. */
pollRouter.post('/admin/:n/move', async (req, res) => {
  const n = Number(req.params.n)
  const parsed = moveSchema.safeParse(req.body)
  if (!Number.isInteger(n) || n < 1 || !parsed.success) {
    res.status(400).json({ error: 'Which day, and a day sooner or later?', code: 'INVALID_BODY' })
    return
  }
  try {
    await requireAdmin(req)
    await movePoll(n, parsed.data.by)
    res.json(await adminPolls(null, parsed.data.count ?? 30))
  } catch (err) {
    fail(err, res)
  }
})

const removeSchema = z.object({ count: z.number().int().min(1).max(120).optional() })

/** Take a question to come out: each after it comes a day sooner. Answers with the list from today. */
pollRouter.post('/admin/:n/remove', async (req, res) => {
  const n = Number(req.params.n)
  const parsed = removeSchema.safeParse(req.body ?? {})
  if (!Number.isInteger(n) || n < 1 || !parsed.success) {
    res.status(400).json({ error: 'Which day?', code: 'INVALID_BODY' })
    return
  }
  try {
    await requireAdmin(req)
    await removePoll(n)
    res.json(await adminPolls(null, parsed.data.count ?? 30))
  } catch (err) {
    fail(err, res)
  }
})
