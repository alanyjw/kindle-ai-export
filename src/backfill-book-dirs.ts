import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  looksLikeBareAsinDir,
  renameBookDir,
  type RenameBookDirDeps
} from './rename-book-dir'
import { fileExists, reportFatalError } from './utils'

/**
 * Rename Kindle out-dirs that were left with a bare ASIN name.
 *
 * Extraction names a book's directory `<asin>-<title>` as soon as Amazon's
 * metadata arrives. When it never does — Amazon has 403'd `startReading` since
 * roughly June 2026 — the title is only recovered later, by OCR during
 * transcription, and the directory keeps its bare ASIN name.
 *
 * `pnpm book` now renames at the end of a run, but books extracted before that
 * are still sitting on the old name. This backfills them.
 *
 * Usage:
 *   pnpm tsx src/backfill-book-dirs.ts --dry-run   # report only
 *   pnpm tsx src/backfill-book-dirs.ts            # rename
 *   pnpm tsx src/backfill-book-dirs.ts out/<dir>  # specific dirs
 */

const nodeFsDeps: RenameBookDirDeps = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, data) => fs.writeFile(p, data),
  rename: (from, to) => fs.rename(from, to),
  exists: fileExists
}

type Outcome =
  | 'renamed'
  | 'would rename'
  | 'skipped: not a bare asin dir'
  | 'skipped: no metadata'
  | 'skipped: no title'
  | 'skipped: already named'
  | 'skipped: target exists'
  | 'failed'

interface Result {
  dir: string
  outcome: Outcome
  to?: string
  rewritten?: number
  detail?: string
}

export async function backfillOne(
  outDir: string,
  { dryRun }: { dryRun: boolean },
  deps: RenameBookDirDeps = nodeFsDeps
): Promise<Result> {
  const dir = path.basename(outDir)

  // The directory name IS the ASIN for exactly the books this targets. Anything
  // else — an already-titled dir, a PDF/EPUB dir named after its source file —
  // is left alone rather than guessed at.
  if (!looksLikeBareAsinDir(dir)) {
    return { dir, outcome: 'skipped: not a bare asin dir' }
  }

  try {
    const result = await renameBookDir({ outDir, asin: dir, dryRun }, deps)

    if (!result.renamed) {
      return { dir, outcome: `skipped: ${result.reason}` as Outcome }
    }

    return {
      dir,
      outcome: dryRun ? 'would rename' : 'renamed',
      to: path.basename(result.to!),
      rewritten: result.rewritten
    }
  } catch (err: any) {
    return {
      dir,
      outcome: 'failed',
      detail: err?.message ?? String(err)
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const explicit = args.filter((a) => !a.startsWith('--'))

  let dirs: string[]
  if (explicit.length > 0) {
    dirs = explicit.map((d) => path.normalize(d))
  } else {
    const entries = await fs.readdir('out', { withFileTypes: true })
    dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join('out', e.name))
      .sort()
  }

  const results: Result[] = []
  for (const dir of dirs) {
    results.push(await backfillOne(dir, { dryRun }))
  }

  // Only the interesting outcomes are worth printing per-book; a library of 50
  // books would otherwise bury them under "not a bare asin dir".
  const acted = results.filter(
    (r) =>
      r.outcome === 'renamed' ||
      r.outcome === 'would rename' ||
      r.outcome === 'failed'
  )

  for (const r of acted) {
    if (r.outcome === 'failed') {
      console.warn(`❌ ${r.dir}: ${r.detail}`)
    } else {
      console.warn(
        `${dryRun ? '📋' : '📁'} ${r.dir} → ${r.to} (${r.rewritten} path(s) repointed)`
      )
    }
  }

  const tally = new Map<Outcome, number>()
  for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1)

  console.warn(
    `\n${dryRun ? 'Dry run' : 'Backfill'} complete over ${results.length} directory(ies):`
  )
  for (const [outcome, count] of [...tally].sort()) {
    console.warn(`  ${outcome}: ${count}`)
  }
  if (dryRun && acted.length > 0) {
    console.warn('\nRe-run without --dry-run to apply.')
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    reportFatalError('Backfill failed', err)
    process.exit(1)
  })
}
