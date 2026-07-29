/**
 * Cleanup for the opening of a PDF section.
 *
 * Print books set chapter openings with a drop cap, and typeset the chapter
 * title on the same page. PDF text extraction flattens both into the reading
 * order, so a section that reads
 *
 *     How has failure shaped you? As a department head, ...
 *
 * arrives as
 *
 *     H Example ow has failure shaped you? As a department head, ...
 *      ^ drop cap
 *        ^^^^^^^ echoed heading
 *                ^^ tail of the drop-capped word
 *
 * Once the heading is rendered as real markdown, that echo is duplicated noise
 * and the split first word is simply wrong. This module removes the echo and
 * rejoins the word.
 */

/** Only scan the start of the text — the echo is always the first thing. */
const MAX_ECHO_SCAN = 200

/**
 * How far past the echo we'll skip whitespace and punctuation looking for the
 * drop-capped word's tail. Headings ending in quotes or a spaced ellipsis
 * (`“I Intend To . . .”`) leave several stranded characters behind.
 */
const MAX_PUNCTUATION_SKIP = 12

/**
 * `A` and `I` are the only single-letter English words, so they're the only
 * drop caps that might stand alone rather than begin the following word. We
 * merge them only when doing so demonstrably produces a real word — checking
 * the *merged* form (not the following token) keeps both directions correct:
 * `A` + `s` → "as" merges, while `A` + `submarine` does not.
 */
const MERGEABLE_A_I_WORDS = new Set([
  'about',
  'above',
  'across',
  'after',
  'again',
  'against',
  'ago',
  'ahead',
  'all',
  'almost',
  'alone',
  'along',
  'already',
  'also',
  'although',
  'always',
  'am',
  'among',
  'amount',
  'an',
  'and',
  'another',
  'answer',
  'any',
  'anyone',
  'anything',
  'anyway',
  'apart',
  'are',
  "aren't",
  'around',
  'as',
  'ask',
  'asked',
  'at',
  'away',
  'idea',
  'if',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'immediately',
  'important',
  'impossible',
  'in',
  'include',
  'indeed',
  'inside',
  'instead',
  'into',
  'is',
  "isn't",
  'it',
  "it's",
  'its',
  'itself'
])

const normalizeApostrophes = (s: string): string => s.replaceAll(/[’‘`]/g, "'")

/** Reduce to the letters and digits only, so punctuation and spacing differences
 * between the outline title and the typeset heading don't block a match. */
const isAlphanumeric = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') ||
  (ch >= 'A' && ch <= 'Z') ||
  (ch >= '0' && ch <= '9')

/**
 * Normalized forms of the heading we might see echoed in the body text. The
 * typeset page routinely omits the outline's `N | ` numbering prefix, so try
 * both with and without it.
 */
function echoCandidates(title: string): string[] {
  const trimmed = title.trim()
  if (!trimmed) return []

  const withoutNumber = trimmed.replace(/^\d+\s*[|.:–—-]\s*/, '')

  const normalize = (s: string): string =>
    [...s]
      .filter((ch) => isAlphanumeric(ch))
      .join('')
      .toUpperCase()

  return [...new Set([normalize(trimmed), normalize(withoutNumber)])].filter(
    (c) => c.length > 0
  )
}

/**
 * Index just past the echoed heading in `text`, or -1 when the heading isn't
 * echoed at the start. Returns the longest match so a candidate that is a
 * prefix of another doesn't win.
 */
function findEchoEnd(text: string, candidates: readonly string[]): number {
  if (candidates.length === 0) return -1

  const longest = Math.max(...candidates.map((c) => c.length))
  const limit = Math.min(text.length, MAX_ECHO_SCAN)

  let normalized = ''
  let end = -1

  for (let i = 0; i < limit; i++) {
    const ch = text[i]!
    if (!isAlphanumeric(ch)) continue

    normalized += ch.toUpperCase()
    if (normalized.length > longest) break
    if (candidates.includes(normalized)) end = i + 1
  }

  return end
}

/** Rejoin a drop cap with the tail of its word, or keep them apart when the
 * drop cap is a standalone `A`/`I`. */
function rejoinDropCap(dropCap: string, rest: string): string {
  // Skip whatever punctuation the heading left stranded (`!”`, ` . . .”`)
  // before the drop-capped word's tail.
  let offset = 0
  while (offset < rest.length && offset <= MAX_PUNCTUATION_SKIP) {
    const ch = rest[offset]!
    if (ch >= 'a' && ch <= 'z') break
    offset++
  }

  const tail = rest.slice(offset)
  const fragment = tail.match(/^[a-z]+(?:'[a-z]+)?/)?.[0]

  // No lowercase tail within reach: this isn't a split word, so leave the drop
  // cap standing on its own.
  if (offset > MAX_PUNCTUATION_SKIP || !fragment) {
    return `${dropCap} ${rest.trimStart()}`
  }

  if (dropCap === 'A' || dropCap === 'I') {
    const merged = normalizeApostrophes((dropCap + fragment).toLowerCase())
    if (!MERGEABLE_A_I_WORDS.has(merged)) {
      return `${dropCap} ${tail}`
    }
  }

  return dropCap + tail
}

/**
 * Strip the echoed heading from the start of a section's body text and repair
 * a split drop cap. Returns `text` unchanged when the heading isn't echoed —
 * without that signal we can't be confident we're looking at a drop cap, and
 * guessing risks mangling ordinary prose.
 */
export function cleanSectionOpening(text: string, title: string): string {
  const candidates = echoCandidates(title)
  if (candidates.length === 0) return text

  const body = text.trimStart()
  if (!body) return text

  // Case 1: heading echoed with no drop cap in front of it.
  const directEnd = findEchoEnd(body, candidates)
  if (directEnd > 0) {
    return body.slice(directEnd).trimStart()
  }

  // Case 2: a drop cap was hoisted ahead of the heading.
  const dropCapMatch = body.match(/^([A-Z])[ \t]+/)
  if (!dropCapMatch) return text

  const dropCap = dropCapMatch[1]!
  const afterDropCap = body.slice(dropCapMatch[0].length)
  const echoEnd = findEchoEnd(afterDropCap, candidates)
  if (echoEnd <= 0) return text

  return rejoinDropCap(dropCap, afterDropCap.slice(echoEnd))
}
