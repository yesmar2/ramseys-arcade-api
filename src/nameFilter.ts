import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
} from 'obscenity'

/*
 * Words no public name may carry: a player's tag, a group's name, an event's
 * title or blurb. Everyone sees these on the boards, kids included.
 *
 * obscenity's English set covers swearing, slurs and sex, and sees through
 * leetspeak, look-alike letters and stretched ones (SH1T, fuuuck). Added: the
 * hate names it leaves out. Let through: real words it would catch. Tags have
 * no spaces, so a tag is also read with its separators taken out (F_U_C_K);
 * titles aren't, since joining their words makes new ones.
 *
 * Only new names are checked. A name already in use keeps working; an admin
 * ban deals with one that got through.
 */

const dataset = new DataSet<{ originalWord: string }>()
  .addAll(englishDataset)
  .addPhrase((p) => p.setMetadata({ originalWord: 'nazi' }).addPattern(pattern`nazi`))
  .addPhrase((p) => p.setMetadata({ originalWord: 'hitler' }).addPattern(pattern`hitler`))
  // Doubled letters are read as one, so "jizz" arrives as "jiz".
  .addPhrase((p) => p.setMetadata({ originalWord: 'jizz' }).addPattern(pattern`jiz`))

const built = dataset.build()

const matcher = new RegExpMatcher({
  ...built,
  whitelistedTerms: [
    ...(built.whitelistedTerms ?? []),
    'cockpit',
    'shiitake',
    'dickson',
    'penistone',
    'wankel',
  ],
  ...englishRecommendedTransformers,
})

/** Checked as plain text, since leetspeak and stretched-letter handling would read them as something else. */
const PLAIN = ['kkk', '1488']

export type NameKind = 'tag' | 'group' | 'title' | 'blurb'

const MESSAGES: Record<NameKind, string> = {
  tag: 'That tag isn’t allowed. Pick another.',
  group: 'That name isn’t allowed. Pick another.',
  title: 'That title isn’t allowed. Try another.',
  blurb: 'The description has a word that isn’t allowed.',
}

/** Whether a name has a word it may not carry. */
export function hasBlockedWord(text: string, kind: NameKind): boolean {
  const lower = text.toLowerCase()
  const readings = [lower, lower.replace(/[^\p{L}\p{N}\s]+/gu, '')]
  if (kind === 'tag') readings.push(lower.replace(/[^\p{L}\p{N}]+/gu, ''))
  return readings.some((r) => matcher.hasMatch(r) || PLAIN.some((w) => r.includes(w)))
}

/** Refuse a new name with a word it may not carry (400, NAME_NOT_ALLOWED). */
export function assertAllowedName(text: string, kind: NameKind): void {
  if (!hasBlockedWord(text, kind)) return
  throw Object.assign(new Error(MESSAGES[kind]), { status: 400, code: 'NAME_NOT_ALLOWED' })
}
