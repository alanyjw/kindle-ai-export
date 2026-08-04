import { statSync } from 'node:fs'
import path from 'node:path'

import { BOOK_USAGE } from './book-flags'
import { resolveOutDir, sanitizeDirname } from './utils'

export type BookArg =
  | { kind: 'pdf'; sourcePath: string; basename: string }
  | { kind: 'epub'; sourcePath: string; basename: string }
  | { kind: 'kindle'; asin: string }
  | { kind: 'outdir'; outDir: string }

export type BookTarget = BookArg & { outDir: string }

const PDF_RE = /\.pdf$/i
const EPUB_RE = /\.epub$/i

function defaultIsExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Classify a CLI input into one of the four pipeline entry shapes.
 *
 * Rule order matters. An ASIN is an opaque alphanumeric string, so shape alone
 * cannot distinguish it from a bare directory name — a path separator is the
 * reliable discriminator (`out/ASIN000001` has one, an ASIN never does), with
 * on-disk existence as the fallback for a bare directory name.
 *
 * `isExistingDir` is injected so this stays a pure function under test.
 */
export function classifyBookArg(
  arg: string | undefined,
  isExistingDir: (p: string) => boolean = defaultIsExistingDir
): BookArg {
  const input = arg?.trim()
  if (!input) {
    throw new Error(`an input is required\n\n${BOOK_USAGE}`)
  }

  if (PDF_RE.test(input) || EPUB_RE.test(input)) {
    const sourcePath = path.resolve(input)
    const basename = sanitizeDirname(
      path.basename(sourcePath, path.extname(sourcePath))
    )
    return PDF_RE.test(input)
      ? { kind: 'pdf', sourcePath, basename }
      : { kind: 'epub', sourcePath, basename }
  }

  const hasSeparator = input.includes('/') || input.includes(path.sep)
  if (hasSeparator || isExistingDir(input)) {
    return { kind: 'outdir', outDir: path.resolve(input) }
  }

  return { kind: 'kindle', asin: input }
}

/**
 * Classify an input and attach the output directory it maps to.
 *
 * Async only for the Kindle case, which needs resolveOutDir()'s scan for an
 * `out/<asin>-<title>` directory (utils.ts:80).
 *
 * Callers that need the historical `ASIN`-from-env fallback should pass
 * `process.argv[2] ?? getEnv('ASIN')`. `book.ts` deliberately does not.
 */
export async function resolveBookTarget(
  arg: string | undefined,
  isExistingDir?: (p: string) => boolean,
  resolveOutDirFn: (asin: string) => Promise<string> = resolveOutDir
): Promise<BookTarget> {
  const classified = classifyBookArg(arg, isExistingDir)

  switch (classified.kind) {
    case 'pdf':
    case 'epub':
      return { ...classified, outDir: path.join('out', classified.basename) }
    case 'kindle':
      return { ...classified, outDir: await resolveOutDirFn(classified.asin) }
    case 'outdir':
      return classified
  }
}
