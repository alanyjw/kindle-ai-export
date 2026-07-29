import 'dotenv/config'

import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { exportBookMarkdown } from './export-book-markdown'
import { closePdfRenderer, getPdfOutline, getPdfPageCount } from './pdf'
import { buildPdfMetadata } from './pdf-metadata'
import type { ContentChunk } from './types'
import { fileExists, reportFatalError } from './utils'

/**
 * Recover the source PDF path recorded in a book's content chunks.
 *
 * The PDF pipeline stores each chunk's provenance as `pdf:<abs path>#page=<n>`,
 * which is the only record of where the book came from — PDF out-dirs have no
 * other pointer back to the file. Returns undefined for Kindle/EPUB content.
 */
export function pdfPathFromContent(
  content: ReadonlyArray<Pick<ContentChunk, 'screenshot'>>
): string | undefined {
  for (const chunk of content) {
    const shot = chunk?.screenshot
    if (typeof shot !== 'string' || !shot.startsWith('pdf:')) continue
    const withoutScheme = shot.slice('pdf:'.length)
    const filePath = withoutScheme.replace(/#page=\d+$/, '')
    if (filePath) return filePath
  }
  return undefined
}

type Outcome =
  | 'backfilled'
  | 'skipped: has metadata'
  | 'skipped: not a PDF book'
  | 'skipped: source PDF not found'
  | 'skipped: source PDF unreadable'
  | 'skipped: no embedded outline'
  | 'failed'

interface Result {
  dir: string
  outcome: Outcome
  tocEntries?: number
  markdownPath?: string
  detail?: string
}

async function backfillOne(
  outDir: string,
  { dryRun }: { dryRun: boolean }
): Promise<Result> {
  const dir = path.basename(outDir)

  if (await fileExists(path.join(outDir, 'metadata.json'))) {
    return { dir, outcome: 'skipped: has metadata' }
  }

  const contentPath = path.join(outDir, 'content.json')
  if (!(await fileExists(contentPath))) {
    return { dir, outcome: 'skipped: not a PDF book' }
  }

  let content: ContentChunk[]
  try {
    const parsed = JSON.parse(await fs.readFile(contentPath, 'utf8'))
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { dir, outcome: 'skipped: not a PDF book' }
    }
    content = parsed as ContentChunk[]
  } catch (err: any) {
    return {
      dir,
      outcome: 'failed',
      detail: `unreadable content.json: ${err?.message || err}`
    }
  }

  const pdfPath = pdfPathFromContent(content)
  if (!pdfPath) return { dir, outcome: 'skipped: not a PDF book' }

  // Distinguish "gone" from "there but unreadable". On macOS, files under
  // iCloud Drive / Desktop / Documents pass an existence check but fail a read
  // check with EPERM until the terminal is granted Full Disk Access — calling
  // that "missing" would send you looking for a file that's sitting right there.
  if (!(await fileExists(pdfPath, constants.F_OK))) {
    return { dir, outcome: 'skipped: source PDF not found', detail: pdfPath }
  }
  if (!(await fileExists(pdfPath, constants.R_OK))) {
    return { dir, outcome: 'skipped: source PDF unreadable', detail: pdfPath }
  }

  try {
    const metadata = await buildPdfMetadata(pdfPath, {
      getPageCount: getPdfPageCount,
      getOutline: getPdfOutline
    })

    if (!metadata) return { dir, outcome: 'skipped: no embedded outline' }
    if (dryRun) {
      return { dir, outcome: 'backfilled', tocEntries: metadata.toc.length }
    }

    await fs.writeFile(
      path.join(outDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    )

    // Omit `pdfBasename` so the title (and therefore the .md filename) stays
    // derived from the out-dir, overwriting the existing export in place
    // rather than orphaning it under a new name.
    const { markdownPath } = await exportBookMarkdown({
      outDir,
      useFileLogger: false
    })

    return {
      dir,
      outcome: 'backfilled',
      tocEntries: metadata.toc.length,
      markdownPath
    }
  } catch (err: any) {
    return { dir, outcome: 'failed', detail: err?.message || String(err) }
  } finally {
    // Free the document before moving to the next book; the loader caches by
    // path and a whole library's worth would otherwise stay resident.
    await closePdfRenderer(pdfPath).catch(() => {})
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const explicitDirs = args.filter((a) => !a.startsWith('--'))

  const outDirs =
    explicitDirs.length > 0
      ? explicitDirs.map((d) => path.resolve(d))
      : (await fs.readdir('out', { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => path.resolve('out', e.name))
          .sort()

  if (dryRun) console.log('DRY RUN — no files will be written\n')

  const results: Result[] = []
  for (const outDir of outDirs) {
    // Sequential on purpose: each book opens a whole PDF, and the progress
    // line is only legible one book at a time.
    const result = await backfillOne(outDir, { dryRun })
    results.push(result)

    if (result.outcome === 'backfilled') {
      console.log(`✅ ${result.dir} — ${result.tocEntries} outline entries`)
    } else if (result.outcome === 'failed') {
      console.log(`❌ ${result.dir} — ${result.detail}`)
    } else if (!result.outcome.startsWith('skipped: not a PDF')) {
      const detail = result.detail ? `\n      ${result.detail}` : ''
      console.log(`⏭️  ${result.dir} — ${result.outcome}${detail}`)
    }
  }

  const tally = new Map<Outcome, number>()
  for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1)

  console.log('\n--- summary ---')
  for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${outcome}`)
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    reportFatalError('PDF metadata backfill failed', err)
    process.exit(1)
  }
}
