import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { globby } from 'globby'

import { exportBookMarkdown } from './export-book-markdown'
import type { BookMetadata, ContentChunk, TocItem } from './types'
import {
  assert,
  fileExists,
  getEnv,
  parseScreenshotFilename,
  resolveOutDir,
  setupTeeLogger
} from './utils'

export type VerificationIssue =
  | {
      kind: 'missing-screenshot'
      screenshot: string
    }
  | {
      kind: 'orphan-chunk'
      screenshot: string
    }
  | {
      kind: 'unparseable-screenshot'
      screenshot: string
    }
  | {
      kind: 'index-mismatch'
      screenshot: string
      stored: number
      expected: number
    }
  | {
      kind: 'page-mismatch'
      screenshot: string
      stored: number
      expected: number
    }
  | {
      kind: 'duplicate-screenshot'
      screenshot: string
      count: number
    }
  | {
      kind: 'empty-chapter'
      title: string
      page: number
      nextPage?: number
    }

const BLANK_MARKER_RE = /^\s*\[BLANK_PAGE]\s*$/

function isMeaningfulText(text: string | undefined): boolean {
  if (!text) return false
  if (BLANK_MARKER_RE.test(text)) return false
  return text.replaceAll(/\s/g, '').length > 0
}

// Find the next TOC entry whose page is strictly greater than `currentPage`.
// Skipping equal/lower pages handles two common TOC artifacts:
//   - sub-headings that share a Kindle page with the previous chapter
//     (nextPage === page → would produce an empty bucket)
//   - back-matter ordering quirks where Bibliography's "page" is reported
//     higher than the following chapter's (e.g. Influence: 491 → 449).
function firstChapterWithPage(
  toc: readonly TocItem[],
  i: number,
  currentPage: number
): number {
  for (let j = i + 1; j < toc.length; j++) {
    const p = toc[j]?.page
    if (typeof p === 'number' && p > currentPage) return p
  }
  return Number.POSITIVE_INFINITY
}

export interface VerifyOptions {
  outDir: string
  // When provided, used as the source-of-truth set of screenshots. If omitted,
  // globs `${outDir}/pages/*.png`.
  pageScreenshots?: string[]
  // When true, rewrites content.json in place to correct index/page fields
  // that don't match their screenshot filename.
  repair?: boolean
}

export interface VerifyResult {
  issues: VerificationIssue[]
  // Absolute paths of files the call modified on disk. Empty unless `repair`
  // was true and repair targets were found.
  modifiedFiles: string[]
  // Number of individual field fixes applied across `modifiedFiles`.
  repairedFieldCount: number
  // Absolute path of the content.json inspected, even if unchanged.
  contentPath: string
}

export async function verifyBookContent(
  opts: VerifyOptions
): Promise<VerifyResult> {
  const { outDir, repair = false } = opts

  const contentPath = path.join(outDir, 'content.json')
  const raw = await fs.readFile(contentPath, 'utf8').catch(() => null)
  if (raw === null) {
    console.warn(`verify: no content.json at ${contentPath}; skipping`)
    return { issues: [], modifiedFiles: [], repairedFieldCount: 0, contentPath }
  }

  const content = JSON.parse(raw) as ContentChunk[]
  assert(Array.isArray(content), `content.json is not an array: ${contentPath}`)

  const pagesDir = path.join(outDir, 'pages')
  const screenshots =
    opts.pageScreenshots ??
    (await globby(`${pagesDir}/*.png`).catch(() => [] as string[]))

  const issues: VerificationIssue[] = []

  // --- 1. Index/page consistency vs. screenshot filename -------------------
  let repairedCount = 0
  const seen = new Map<string, number>()
  for (const chunk of content) {
    seen.set(chunk.screenshot, (seen.get(chunk.screenshot) ?? 0) + 1)

    const parsed = parseScreenshotFilename(chunk.screenshot)
    if (!parsed) {
      // Non-screenshot chunks (e.g. `pdf:...#page=N`) are skipped.
      if (!chunk.screenshot.startsWith('pdf:')) {
        issues.push({
          kind: 'unparseable-screenshot',
          screenshot: chunk.screenshot
        })
      }
      continue
    }

    if (chunk.index !== parsed.index) {
      issues.push({
        kind: 'index-mismatch',
        screenshot: chunk.screenshot,
        stored: chunk.index,
        expected: parsed.index
      })
      if (repair) {
        chunk.index = parsed.index
        repairedCount++
      }
    }

    if (chunk.page !== parsed.page) {
      issues.push({
        kind: 'page-mismatch',
        screenshot: chunk.screenshot,
        stored: chunk.page,
        expected: parsed.page
      })
      if (repair) {
        chunk.page = parsed.page
        repairedCount++
      }
    }
  }

  for (const [screenshot, count] of seen) {
    if (count > 1) {
      issues.push({ kind: 'duplicate-screenshot', screenshot, count })
    }
  }

  // --- 2. Screenshot ↔ content.json coverage -------------------------------
  // A chunk is an orphan if its screenshot path doesn't resolve to a real
  // file on disk. This catches the "stale-prefix" case (dir renamed from
  // ASIN → ASIN-Title with content.json still referencing the old prefix)
  // even when basenames match.
  //
  // With --repair we try two recoveries before dropping:
  //   1. Rewrite the chunk's screenshot to the live path with the same
  //      basename, if exactly one such live screenshot exists. This rescues
  //      stale-prefix chunks without losing the existing OCR text.
  //   2. If a chunk with the live path already exists (i.e. we'd create a
  //      duplicate), drop the orphan instead.
  //   3. Otherwise (basename has no live screenshot at all), drop.
  let droppedOrphans = 0
  let rewrittenOrphans = 0
  if (screenshots.length > 0) {
    const screenshotByBasename = new Map<string, string>()
    for (const s of screenshots) screenshotByBasename.set(path.basename(s), s)

    // Compute coverage AFTER orphan-rewrite would happen, so missing-screenshot
    // reflects post-repair state in dry-run too.
    const livePaths = new Set<string>()
    for (const c of content) {
      if (c.screenshot.startsWith('pdf:')) continue
      if (await fileExists(c.screenshot)) {
        livePaths.add(c.screenshot)
      }
    }

    const orphanIndexes: number[] = []
    for (let i = 0; i < content.length; i++) {
      const c = content[i]!
      if (c.screenshot.startsWith('pdf:')) continue
      if (livePaths.has(c.screenshot)) continue
      issues.push({ kind: 'orphan-chunk', screenshot: c.screenshot })
      orphanIndexes.push(i)
    }

    if (repair && orphanIndexes.length > 0) {
      // Walk orphans: try rewrite first, drop the rest.
      const liveByBasename = new Map<string, string>()
      for (const p of livePaths) liveByBasename.set(path.basename(p), p)

      const toDrop: number[] = []
      for (const i of orphanIndexes) {
        const c = content[i]!
        const live = screenshotByBasename.get(path.basename(c.screenshot))
        if (live && !liveByBasename.has(path.basename(live))) {
          // No existing chunk for the live path — adopt this one.
          c.screenshot = live
          liveByBasename.set(path.basename(live), live)
          livePaths.add(live)
          rewrittenOrphans++
        } else {
          toDrop.push(i)
        }
      }
      // Drop in reverse so earlier indexes stay valid.
      for (let i = toDrop.length - 1; i >= 0; i--) {
        content.splice(toDrop[i]!, 1)
        droppedOrphans++
      }
      if (rewrittenOrphans > 0) {
        console.log(
          `verify: rewrote ${rewrittenOrphans} orphan chunk path(s) to live screenshot(s)`
        )
      }
      if (droppedOrphans > 0) {
        console.log(
          `verify: dropped ${droppedOrphans} unsalvageable orphan chunk(s)`
        )
      }
    }

    // Recompute coverage for missing-screenshot after any repair.
    const liveBasenames = new Set([...livePaths].map((p) => path.basename(p)))
    for (const s of screenshots) {
      if (!liveBasenames.has(path.basename(s))) {
        issues.push({ kind: 'missing-screenshot', screenshot: s })
      }
    }
  }

  // --- 3. Chapter coverage (only when metadata.json is present) ------------
  const metadataPath = path.join(outDir, 'metadata.json')
  if (await fileExists(metadataPath)) {
    const metadata = JSON.parse(
      await fs.readFile(metadataPath, 'utf8')
    ) as BookMetadata
    const toc = metadata.toc ?? []
    for (let i = 0; i < toc.length; i++) {
      const item = toc[i]!
      if (typeof item.page !== 'number') continue
      const nextPage = firstChapterWithPage(toc, i, item.page)
      // Skip the trailing TOC item entirely (typically About-the-Author /
      // Index / Acknowledgments). These are usually 1–2 pages, often with
      // photos or sparse text that OCR returns as [BLANK_PAGE]; flagging
      // them creates noise without surfacing real bugs.
      const isTrailer = !Number.isFinite(nextPage) && i === toc.length - 1
      if (isTrailer) continue

      // Skip 1-page ranges. They produce false positives when several TOC
      // subsections share a Kindle page: the lone chunk for that page is
      // associated with the first subsection, leaving the rest "empty"
      // even though the underlying text is fine. The original bug we're
      // trying to catch (a multi-page chapter rendered as [BLANK_PAGE])
      // always spans more than one page.
      if (nextPage - item.page <= 1) continue

      const chapterChunks = content.filter(
        (c) => c.page >= item.page! && c.page < nextPage
      )
      const hasContent = chapterChunks.some((c) => isMeaningfulText(c.text))
      if (!hasContent) {
        issues.push({
          kind: 'empty-chapter',
          title: item.title,
          page: item.page,
          nextPage: Number.isFinite(nextPage) ? nextPage : undefined
        })
      }
    }
  }

  // --- Output --------------------------------------------------------------
  if (issues.length === 0) {
    console.log(
      `verify: ok (${content.length} chunks, ${screenshots.length} screenshots)`
    )
  } else {
    console.warn(`verify: ${issues.length} issue(s) in ${contentPath}`)
    const summary = new Map<string, number>()
    for (const issue of issues) {
      summary.set(issue.kind, (summary.get(issue.kind) ?? 0) + 1)
    }
    for (const [kind, count] of summary) {
      console.warn(`  - ${kind}: ${count}`)
    }
    for (const issue of issues.slice(0, 25)) {
      console.warn('  ·', issue)
    }
    if (issues.length > 25) {
      console.warn(`  · (…and ${issues.length - 25} more)`)
    }
  }

  const modifiedFiles: string[] = []
  const totalRepairs = repairedCount + droppedOrphans + rewrittenOrphans
  if (repair && totalRepairs > 0) {
    const sorted = [...content].sort(
      (a, b) => a.index - b.index || a.page - b.page
    )
    await fs.writeFile(contentPath, JSON.stringify(sorted, null, 2))
    modifiedFiles.push(contentPath)
    const parts: string[] = []
    if (repairedCount > 0) parts.push(`${repairedCount} field(s)`)
    if (rewrittenOrphans > 0)
      parts.push(`${rewrittenOrphans} rewritten orphan(s)`)
    if (droppedOrphans > 0) parts.push(`${droppedOrphans} dropped orphan(s)`)
    console.log(
      `verify: repaired ${parts.join(', ')} in content.json (wrote ${contentPath})`
    )
    console.log(`modified: ${contentPath}`)
  }

  return {
    issues,
    modifiedFiles,
    repairedFieldCount: totalRepairs,
    contentPath
  }
}

function extractFlagValue(args: string[], name: string): string | true | null {
  // Supports `--name`, `--name=value`, and `--name value` forms.
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === `--${name}`) {
      const next = args[i + 1]
      if (next && !next.startsWith('--')) return next
      return true
    }
    if (a.startsWith(`--${name}=`)) {
      return a.slice(name.length + 3)
    }
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const repair = args.includes('--repair')
  const exportMarkdown = args.includes('--export')
  const exportAll = args.includes('--export-all')
  const logFlag = extractFlagValue(args, 'log')
  const positional = args.filter(
    (a, i) =>
      !a.startsWith('--') &&
      // Skip the value-half of `--log <path>` when used in the spaced form.
      !(i > 0 && args[i - 1] === '--log' && typeof logFlag === 'string')
  )

  if (logFlag) {
    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
    const logPath =
      typeof logFlag === 'string'
        ? path.resolve(logFlag)
        : path.resolve('out', `verify-${stamp}.log`)
    const { logPath: resolved } = await setupTeeLogger(logPath)
    console.log(`verify: tee-logging to ${resolved}`)
  }

  let outDirs: string[]
  if (positional.length > 0) {
    outDirs = positional.map((a) => path.resolve(a))
  } else {
    const asin = getEnv('ASIN')
    assert(asin, 'ASIN is required (or pass one or more book output dirs)')
    outDirs = [await resolveOutDir(asin)]
  }

  const results: Array<
    { outDir: string; exportedMarkdown?: string } & VerifyResult
  > = []
  for (const outDir of outDirs) {
    if (outDirs.length > 1) console.log(`\n--- ${outDir} ---`)
    const res = await verifyBookContent({ outDir, repair })

    // Regenerate markdown when:
    //   --export-all → every passed dir
    //   --export     → only dirs whose content.json was just repaired
    const shouldExport =
      exportAll || (exportMarkdown && res.modifiedFiles.length > 0)
    let exportedMarkdown: string | undefined
    if (shouldExport) {
      try {
        const exportResult = await exportBookMarkdown({
          outDir,
          useFileLogger: false
        })
        exportedMarkdown = exportResult.markdownPath
        console.log(`modified: ${exportedMarkdown}`)
      } catch (err: any) {
        console.warn(`export failed for ${outDir}: ${err?.message || err}`)
      }
    }

    results.push({ outDir, ...res, exportedMarkdown })
  }

  // Summary across all processed dirs — makes bulk runs (e.g. `for d in out/*/`)
  // easy to scan and greppable via `^modified:` or the summary block.
  if (outDirs.length > 1 || repair || exportMarkdown || exportAll) {
    const modified = results.filter((r) => r.modifiedFiles.length > 0)
    const exported = results.filter((r) => r.exportedMarkdown)
    const withIssues = results.filter(
      (r) => r.issues.length > 0 && r.modifiedFiles.length === 0
    )
    const totalRepaired = results.reduce(
      (sum, r) => sum + r.repairedFieldCount,
      0
    )

    console.log('\n=== verify summary ===')
    console.log(`  processed:       ${results.length}`)
    if (repair) {
      console.log(`  files modified:  ${modified.length}`)
      console.log(`  fields repaired: ${totalRepaired}`)
      if (modified.length > 0) {
        console.log('  modified files:')
        for (const r of modified) {
          for (const f of r.modifiedFiles) {
            console.log(`    - ${f} (${r.repairedFieldCount} field(s))`)
          }
        }
      }
    }
    if (exportMarkdown || exportAll) {
      console.log(`  markdown exported: ${exported.length}`)
      if (exported.length > 0) {
        console.log('  exported files:')
        for (const r of exported) {
          console.log(`    - ${r.exportedMarkdown}`)
        }
      }
    }
    if (withIssues.length > 0) {
      console.log(`  books with unresolved issues: ${withIssues.length}`)
      for (const r of withIssues) {
        console.log(`    - ${r.outDir} (${r.issues.length} issue(s))`)
      }
    }
  }

  const anyUnresolved = results.some(
    (r) => r.issues.length > 0 && r.modifiedFiles.length === 0
  )
  if (anyUnresolved && !repair) {
    process.exitCode = 1
  }
}

// Only run main when invoked directly (not when imported by transcribe).
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
