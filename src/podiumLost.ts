import { getClaim } from './names.js'
import { isBanned } from './bans.js'
import { listFriends } from './friends.js'
import { notify } from './notifications.js'
import { boardDateKey, dayPlayers, dayStartMs, isRankedGame, type GameSlug } from './store.js'
import { DAY_TOP_TICKETS } from './tickets.js'
import { TODAY_DAILIES, todayRule } from './today.js'
import { scoreFigure } from './words.js'

/*
 * Knocked off the podium: a racing daily's run that takes a top-three place pushes whoever had third down to
 * fourth, and they hear so while the day's still on, since a lap or a run can be had again and the day's top
 * three are paid tickets after midnight (tickets.ts DAY_TOP_TICKETS). Ramsey picked it (2026-10-05) from ideas
 * to bring players back to the racing dailies: only a friend beating you was told before (todayBeaten.ts).
 *
 * A friend of the one who passed you hears it from todayBeaten.ts instead, so one run never sends two pushes.
 * Once a day for each daily, however often the place is lost: a day of trading third isn't a stream of alerts.
 */

export type RacingDaily = 'hotlap' | 'marblerun' | 'lander' | 'swoop' | 'wobblerun'

export const RACING_DAILIES: ReadonlySet<string> = new Set<RacingDaily>(['hotlap', 'marblerun', 'lander', 'swoop', 'wobblerun'])

const WHAT: Record<RacingDaily, { daily: string; run: string }> = {
  hotlap: { daily: 'Today’s Track', run: 'lap' },
  marblerun: { daily: 'Today’s Course', run: 'run' },
  lander: { daily: 'Today’s Cave', run: 'run' },
  swoop: { daily: 'Today’s Hills', run: 'run' },
  wobblerun: { daily: 'Today’s Gauntlet', run: 'run' },
}

const PODIUM = DAY_TOP_TICKETS.length

/** Whether a game's run can knock someone off today's podium: a racing daily on today's card. */
export function hasPodium(game: GameSlug, now = Date.now()): game is RacingDaily {
  if (!RACING_DAILIES.has(game) || !isRankedGame(game)) return false
  const key = TODAY_DAILIES.find((d) => d.game === game)?.key
  return Boolean(key && todayRule(boardDateKey(now)).live.includes(key))
}

/** Today's top three on a racing daily, by tag: read before a run is saved, to see who it pushes out. */
export async function podiumNames(game: RacingDaily, now = Date.now()): Promise<string[]> {
  return (await dayPlayers(game, boardDateKey(now))).slice(0, PODIUM).map((p) => p.name)
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`

/** Tell whoever this run pushed off today's podium. `before` is the top three as they were before it was saved. */
export async function tellPodiumLost(opts: {
  game: RacingDaily
  before: readonly string[]
  /** The tag whose run it was, and their account. */
  name: string
  accountId: string
  now: number
}): Promise<number> {
  const today = boardDateKey(opts.now)
  const field = await dayPlayers(opts.game, today)
  const top = new Set(field.slice(0, PODIUM).map((p) => p.name))
  const out = opts.before.filter((name) => name !== opts.name && !top.has(name))
  if (!out.length) return 0
  const passer = field.find((p) => p.name === opts.name)
  if (!passer) return 0
  const friends = new Set((await listFriends(opts.accountId)).map((f) => f.accountId))
  const start = dayStartMs(today)
  // Thirty hours on is always the next day, however long a day is when the clocks change.
  const endsAt = dayStartMs(boardDateKey(start + 30 * 3_600_000))
  const day = `${String(today).slice(0, 4)}-${String(today).slice(4, 6)}-${String(today).slice(6, 8)}`
  const what = WHAT[opts.game]
  let told = 0
  for (const name of out) {
    const accountId = (await getClaim(name))?.accountId
    if (!accountId || accountId === opts.accountId || friends.has(accountId)) continue
    if (await isBanned(name, accountId)) continue
    const place = field.findIndex((p) => p.name === name) + 1
    const filed = await notify({
      accountId,
      kind: 'podium-lost',
      title: `You’re off the podium on ${what.daily}`,
      body: `${opts.name}’s ${what.run} of ${scoreFigure(opts.game, passer.score)} put you ${ordinal(place)}. Win a top-three place back before the day ends, and its tickets with it.`,
      href: `/games/${opts.game}`,
      meta: { actor: opts.name, game: opts.game, place, endsAt, playHref: `/games/${opts.game}/play` },
      digestKey: `podium-lost:${day}:${opts.game}`,
      once: true,
      now: opts.now,
    }).catch(() => null)
    if (filed?.created) told++
  }
  return told
}
