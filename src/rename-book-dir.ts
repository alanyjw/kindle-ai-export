/**
 * Late rename of a book's output directory to `out/<asin>-<title>`.
 *
 * Extraction renames the out-dir as soon as Amazon's metadata arrives, and it
 * does so BEFORE the page loop so every recorded path is written with the final
 * name. When that metadata never arrives (Amazon has 403'd `startReading` since
 * ~June 2026) the title is instead recovered later, by OCR'ing the title page
 * during transcription — long after `content.json` and `metadata.json` have
 * recorded paths under the bare-ASIN directory.
 *
 * So a late rename cannot just move the directory: `content.json` chunks,
 * `metadata.json` `pages[]`, and `frontMatter[]` all embed the out-dir path.
 * Leaving them stale is worse than not renaming — the transcribe step matches
 * already-done pages by that path, so it would re-OCR the entire book at cost,
 * and `verifyBookContent` would report every page missing.
 *
 * This module therefore moves the directory and repoints every recorded path
 * as one operation. It is pure apart from an injectable filesystem, so the
 * rewrite rules are unit-tested rather than exercised against a real library.
 */

import path from 'node:path'

import { sanitizeDirname } from './utils'

/**
 * The directory name a book should have, matching the name extraction's own
 * early rename produces. Returns undefined when there is no usable title.
 */
export function bookDirName(
  asin: string,
  title: string | undefined
): string | undefined {
  if (typeof title !== 'string') return undefined
  const sanitized = sanitizeDirname(title)
  if (!sanitized) return undefined
  return `${asin}-${sanitized}`
}

/**
 * Repoint a single recorded path at the renamed directory.
 *
 * Only rewrites paths of the exact shape `out/<oldBase>/...`. Matching on whole
 * path segments (rather than a string prefix) matters twice over: it leaves
 * `pdf:`/`epub:` provenance markers alone — they are the only record of where a
 * book came from — and it refuses to match a sibling whose name merely starts
 * with the same characters.
 */
export function rewriteOutDirPath(
  recorded: string,
  oldBase: string,
  newBase: string
): string {
  if (typeof recorded !== 'string') return recorded
  const segments = recorded.split('/')
  if (segments[0] !== 'out' || segments[1] !== oldBase) return recorded
  return ['out', newBase, ...segments.slice(2)].join('/')
}

export interface RewriteResult<T> {
  value: T
  rewritten: number
}

/**
 * Immutably rewrite every `screenshot` field reachable in a parsed JSON value.
 *
 * Walks arrays and plain objects rather than targeting `pages`/`frontMatter`/
 * chunk shapes by name, so a future field carrying a page path is covered
 * without this module having to learn about it.
 */
export function rewriteScreenshotRefs<T>(
  value: T,
  oldBase: string,
  newBase: string
): RewriteResult<T> {
  let rewritten = 0

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((item) => walk(item))
    if (node === null || typeof node !== 'object') return node

    const entries = Object.entries(node as Record<string, unknown>).map(
      ([key, val]) => {
        if (key === 'screenshot' && typeof val === 'string') {
          const next = rewriteOutDirPath(val, oldBase, newBase)
          if (next !== val) rewritten += 1
          return [key, next] as const
        }
        return [key, walk(val)] as const
      }
    )

    return Object.fromEntries(entries)
  }

  return { value: walk(value) as T, rewritten }
}

/** Injectable filesystem so the orchestration is testable. */
export interface RenameBookDirDeps {
  readFile: (filePath: string) => Promise<string>
  writeFile: (filePath: string, data: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  exists: (filePath: string) => Promise<boolean>
}

export interface RenameBookDirOptions {
  outDir: string
  asin: string
  /** Report what would change without touching the filesystem. */
  dryRun?: boolean
}

export type RenameSkipReason =
  | 'no metadata'
  | 'not a kindle book'
  | 'no title'
  | 'already named'
  | 'target exists'

export interface RenameBookDirResult {
  renamed: boolean
  /** Directory to use after this call — the new one, or the original. */
  outDir: string
  from: string
  to?: string
  /** How many recorded paths were repointed. */
  rewritten: number
  reason?: RenameSkipReason
}

// The two files that embed out-dir paths. `content.json` is absent until the
// transcribe step has run, which is a normal state, not an error.
const PATH_BEARING_FILES = ['metadata.json', 'content.json'] as const

/**
 * Move `out/<asin>` to `out/<asin>-<title>` and repoint every recorded path.
 *
 * Safe to call unconditionally: a book that is already correctly named, has no
 * recovered title, or would collide with an existing directory is reported as
 * skipped rather than touched.
 */
export async function renameBookDir(
  { outDir, asin, dryRun = false }: RenameBookDirOptions,
  deps: RenameBookDirDeps
): Promise<RenameBookDirResult> {
  const skip = (reason: RenameSkipReason): RenameBookDirResult => ({
    renamed: false,
    outDir,
    from: outDir,
    rewritten: 0,
    reason
  })

  type Metadata = { meta?: { title?: string }; source?: string }
  let metadata: Metadata
  try {
    metadata = JSON.parse(
      await deps.readFile(path.join(outDir, 'metadata.json'))
    ) as Metadata
  } catch {
    return skip('no metadata')
  }

  // `<asin>-<title>` is a Kindle naming convention. PDF and EPUB out-dirs are
  // named after their source file and carry `source`; EPUB metadata also
  // carries a title, so without this a 10-character EPUB directory would be
  // renamed to `<filename>-<title>`.
  if (metadata?.source) return skip('not a kindle book')

  const newBase = bookDirName(asin, metadata?.meta?.title)
  if (!newBase) return skip('no title')

  const oldBase = path.basename(outDir)
  if (oldBase === newBase) return skip('already named')

  const newOutDir = path.join(path.dirname(outDir), newBase)
  // Never clobber: a directory already at the target could be another export.
  if (await deps.exists(newOutDir)) return skip('target exists')

  // Read and rewrite before moving anything, so a parse failure can't leave a
  // half-renamed book behind.
  const rewrites: Array<{ file: string; data: string }> = []
  let rewritten = 0
  for (const file of PATH_BEARING_FILES) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await deps.readFile(path.join(outDir, file)))
    } catch {
      continue // Absent (or unreadable) — nothing of ours to repoint.
    }
    const result = rewriteScreenshotRefs(parsed, oldBase, newBase)
    rewritten += result.rewritten
    rewrites.push({ file, data: JSON.stringify(result.value, null, 2) })
  }

  if (dryRun) {
    return {
      renamed: true,
      outDir: newOutDir,
      from: outDir,
      to: newOutDir,
      rewritten
    }
  }

  await deps.rename(outDir, newOutDir)
  // Written to the NEW directory — the old path no longer exists.
  for (const { file, data } of rewrites) {
    await deps.writeFile(path.join(newOutDir, file), data)
  }

  return {
    renamed: true,
    outDir: newOutDir,
    from: outDir,
    to: newOutDir,
    rewritten
  }
}

/**
 * Is this directory name a bare ASIN — i.e. one extraction never renamed?
 *
 * Amazon ASINs are 10 alphanumeric characters. Requiring that exact shape is
 * what keeps the backfill away from PDF- and EPUB-sourced directories, which
 * are named after their source file and must never be given an ASIN prefix.
 * A directory already named `<asin>-<title>` fails this test too, which is
 * correct: it needs no rename.
 */
export function looksLikeBareAsinDir(dirName: string): boolean {
  return /^[a-z0-9]{10}$/i.test(dirName)
}
