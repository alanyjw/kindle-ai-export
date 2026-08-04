import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveBookMeta } from './book-meta'
import { resolveBookTarget } from './book-input'
import { stripOcrBoilerplate } from './ocr-boilerplate'
import { cleanSectionOpening } from './pdf-drop-cap'
import type { BookMetadata, ContentChunk } from './types'
import {
  assert,
  createProgressBar,
  fileExists,
  getEnv,
  progressBarNewline,
  reportFatalError,
  sanitizeDirname,
  setupTimestampedLogger
} from './utils'

// Joins chunks while removing overlapping or duplicate text between adjacent
// chunks. Multi-screen captures of the same print page often produce chunks
// whose OCR text fully overlaps (the chevron click changed `src` but the
// rendered content was effectively identical) or partially overlaps (the
// content slid by a few lines). Naive concatenation duplicates citations,
// title cards, and chapter ends in the .md. Detecting and stripping these
// overlaps at join time keeps the source content.json untouched.
function joinChunksDedupingOverlap(
  chunks: ReadonlyArray<{ text: string }>,
  separator: string
): string {
  if (chunks.length === 0) return ''

  const normalize = (s: string): string => s.replaceAll(/\s+/g, ' ').trim()
  // Strip the OCR's AI-generated descriptor lines (`[OTHER] ...`, `[ICON] ...`).
  // These describe imagery rather than transcribe text, and consecutive screen
  // captures of the same image often emit different wordings for the same
  // descriptor — so they break naive equality even when the actual text content
  // of the two chunks is identical.
  const stripDescriptors = (s: string): string =>
    normalize(s.replaceAll(/\[(?:OTHER|ICON)\][^\n]*/g, ''))

  const out: string[] = [chunks[0]!.text]
  for (let i = 1; i < chunks.length; i++) {
    const prev = out.at(-1)!
    const next = chunks[i]!.text

    // Case 1: full duplicate — next is contained in prev modulo whitespace.
    const prevN = normalize(prev)
    const nextN = normalize(next)
    if (nextN.length > 0 && prevN.includes(nextN)) {
      continue
    }

    // Case 2: same text content, just different AI image descriptors. Catches
    // chapter-title cards where the print page is mostly imagery and each
    // screen capture produces a slightly different `[OTHER] ...` description
    // of the same visual.
    const prevStripped = stripDescriptors(prev)
    const nextStripped = stripDescriptors(next)
    if (nextStripped.length > 0 && prevStripped.includes(nextStripped)) {
      continue
    }

    // Case 3: tail-of-prev overlaps head-of-next. Walk down from the longest
    // possible overlap and cut the duplicate prefix from `next`. Floor at 40
    // chars to avoid stripping coincidental short suffix matches like "the".
    const minOverlap = 40
    const maxOverlap = Math.min(prev.length, next.length)
    let overlap = 0
    for (let len = maxOverlap; len >= minOverlap; len--) {
      if (prev.endsWith(next.slice(0, len))) {
        overlap = len
        break
      }
    }
    out.push(overlap > 0 ? next.slice(overlap) : next)
  }
  return out.join(separator)
}

export interface FormatPdfTextOptions {
  // Detect `Part …` / `Chapter N …` lines and promote them to headings. Only
  // useful as a fallback: it relies on the heading sitting at the start of its
  // own line, which embedded PDF text (one line per page) never satisfies.
  // When the PDF's own outline supplies the headings, leave this off so the
  // same heading isn't emitted twice.
  detectHeadings?: boolean
}

function formatPdfTextToMarkdown(
  body: string,
  opts: FormatPdfTextOptions = {}
): string {
  const { detectHeadings = true } = opts
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  const out: string[] = []

  const pushBlank = () => {
    if (out.length === 0) return
    if (out.at(-1) !== '') out.push('')
  }

  const splitHeadingAndRest = (
    line: string,
    kind: 'part' | 'chapter'
  ): { heading: string; rest: string } => {
    const trimmed = line.trim()
    const prefixLen =
      kind === 'part'
        ? (trimmed.match(/^part\b/i)?.[0].length ?? 0)
        : (trimmed.match(/^chapter\s+\d+\b/i)?.[0].length ?? 0)

    const after = trimmed.slice(prefixLen)
    const m = after.match(/\s+[A-Z][a-z]/)
    if (m && m.index !== undefined) {
      const pos = prefixLen + m.index
      return {
        heading: trimmed.slice(0, pos).trim(),
        rest: trimmed.slice(pos).trim()
      }
    }

    return { heading: trimmed, rest: '' }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      out.push('')
      continue
    }

    const cleanedLine = stripOcrBoilerplate(line)
    if (!cleanedLine) continue

    if (detectHeadings && /^part\b/i.test(cleanedLine)) {
      const { heading, rest } = splitHeadingAndRest(cleanedLine, 'part')
      pushBlank()
      out.push(`## ${heading}`)
      out.push('')
      if (rest) out.push(rest)
      continue
    }

    if (detectHeadings && /^chapter\s+\d+\b/i.test(cleanedLine)) {
      const { heading, rest } = splitHeadingAndRest(cleanedLine, 'chapter')
      pushBlank()
      out.push(`## ${heading}`)
      out.push('')
      if (rest) out.push(rest)
      continue
    }

    out.push(cleanedLine)
  }

  // Normalize spacing: max 2 consecutive blank lines
  return out
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

// Markdown heading prefix for a TOC entry. The book title owns `#`, so a
// top-level entry (level 0) is `##` and its chapters are `###`. Clamped at
// `######`, the deepest heading markdown defines.
function headingPrefix(level: number | undefined): string {
  return '#'.repeat(Math.min(6, 2 + Math.max(0, level ?? 0)))
}

function anchorFor(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Render one PDF section: its chunks joined page-by-page, with the section's
// echoed heading and split drop cap repaired at the opening.
function renderPdfSectionBody(
  chunks: ReadonlyArray<ContentChunk>,
  title?: string
): string {
  const cleaned = chunks.map((chunk, i) => {
    const text = stripOcrBoilerplate(chunk.text)
    return {
      text: i === 0 && title ? cleanSectionOpening(text, title) : text
    }
  })

  // Blank-line separator between pages: embedded PDF text arrives as one line
  // per page, so page boundaries are the only paragraph breaks available.
  const body = joinChunksDedupingOverlap(cleaned, '\n\n')
  return formatPdfTextToMarkdown(body, { detectHeadings: !title })
}

export interface ExportBookMarkdownOptions {
  outDir: string
  pdfBasename?: string
  // When true (default), hijacks console output to a timestamped log file in
  // `<outDir>/logs/`. Callers that invoke this in a loop or need stdout should
  // pass `false`.
  useFileLogger?: boolean
}

export interface ExportBookMarkdownResult {
  markdownPath: string
  mode: 'kindle' | 'content-only'
  sectionsProcessed?: number
  pagesProcessed?: number
}

export async function exportBookMarkdown(
  opts: ExportBookMarkdownOptions
): Promise<ExportBookMarkdownResult> {
  const { outDir, pdfBasename, useFileLogger = true } = opts

  if (useFileLogger) {
    await setupTimestampedLogger(outDir)
  }

  const content = JSON.parse(
    await fs.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  assert(content.length, 'no book content found')

  const metadataPath = path.join(outDir, 'metadata.json')
  const hasMetadata = await fileExists(metadataPath)

  const metadata = hasMetadata
    ? (JSON.parse(await fs.readFile(metadataPath, 'utf8')) as BookMetadata)
    : undefined

  // PDF mode. Uses page-separated joining (embedded PDF text is one line per
  // page, so page breaks are the only paragraph structure available) rather
  // than the Kindle path's space-joining, which would collapse a whole chapter
  // into a single paragraph. Sections come from the PDF's embedded outline
  // when metadata.json carries one; otherwise the whole book is one blob and
  // headings fall back to text-shape detection.
  if (!hasMetadata || metadata?.source === 'pdf') {
    const title = pdfBasename || path.basename(outDir)
    const safeTitle = sanitizeDirname(title)

    const sorted = [...content].sort(
      (a, b) => a.page - b.page || a.index - b.index
    )
    const toc = (metadata?.toc ?? []).filter((t) => t.page !== undefined)

    const bar = createProgressBar(toc.length || sorted.length)

    const sections: string[] = []

    if (toc.length === 0) {
      const body = renderPdfSectionBody(sorted)
      bar.tick(sorted.length)
      if (body) sections.push(body)
    } else {
      const startIndexOf = (page: number) =>
        sorted.findIndex((c) => c.page >= page)

      // Anything before the first outline entry (a cover page the outline
      // skips, say) would otherwise be silently dropped.
      const firstStart = startIndexOf(toc[0]!.page!)
      if (firstStart > 0) {
        const preamble = renderPdfSectionBody(sorted.slice(0, firstStart))
        if (preamble) sections.push(preamble)
      }

      for (const [i, tocItem] of toc.entries()) {
        const startIndex = startIndexOf(tocItem.page!)
        if (startIndex === -1) continue

        const nextPage = toc[i + 1]?.page
        const nextIndex =
          nextPage === undefined ? sorted.length : startIndexOf(nextPage)
        const endIndex =
          nextIndex === -1 ? sorted.length : Math.max(startIndex, nextIndex)

        const body = renderPdfSectionBody(
          sorted.slice(startIndex, endIndex),
          tocItem.title
        )

        sections.push(
          body
            ? `${headingPrefix(tocItem.level)} ${tocItem.title}\n\n${body}`
            : `${headingPrefix(tocItem.level)} ${tocItem.title}`
        )
        bar.tick(1)
      }
    }

    progressBarNewline()

    const tocBlock =
      toc.length === 0
        ? ''
        : `## Table of Contents\n\n${toc
            .map(
              (tocItem) =>
                `${'  '.repeat(Math.max(0, tocItem.level ?? 0))}- [${tocItem.title}](#${anchorFor(tocItem.title)})`
            )
            .join('\n')}\n\n---\n\n`

    const output = `# ${title}\n\n${tocBlock}${sections.join('\n\n')}\n`
    const markdownPath = path.join(outDir, `${safeTitle}.md`)
    await fs.writeFile(markdownPath, output)
    console.log(`Export complete. Wrote markdown to: ${markdownPath}`)
    console.log(`Pages processed: ${sorted.length}`)
    if (toc.length > 0) {
      console.log(`TOC sections processed: ${toc.length}`)
    }
    return {
      markdownPath,
      mode: 'content-only',
      pagesProcessed: sorted.length,
      ...(toc.length > 0 ? { sectionsProcessed: toc.length } : {})
    }
  }

  // Kindle mode (existing)
  assert(metadata, 'invalid book metadata')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  // Degrade gracefully when `meta` is missing (e.g. Amazon 403'd the reader
  // metadata API during extraction) instead of hard-failing a fully
  // transcribed book over two missing strings. resolveBookMeta falls back to a
  // title derived from the out-dir and warns how to set the real one.
  const resolved = resolveBookMeta(metadata, outDir)
  if (resolved.warning) {
    console.warn(resolved.warning)
  }
  const title = resolved.title
  const authors = resolved.authorList

  // Detect location-mode by majority — mirrors the extract pipeline. Hybrid
  // books like reflowable text with one stray back-matter page entry are
  // dominated by location entries and should be treated as location-mode.
  const tocPageCount = metadata.toc.filter((i) => i.page !== undefined).length
  const tocLocationCount = metadata.toc.filter(
    (i) => i.location !== undefined
  ).length
  const useLocationMode = tocLocationCount > tocPageCount
  const tocPositionOf = (item: { page?: number; location?: number }) =>
    useLocationMode ? item.location : item.page

  // Count actual items that will be processed (have positions and can find
  // content). Iterate the full TOC — the final entry is a real content section
  // (often the last chapter), so excluding it drops everything from its start
  // page to the end of the book.
  let actualProcessableCount = 0
  for (let i = 0; i < metadata.toc.length; i++) {
    const tocItem = metadata.toc[i]!
    const pos = tocPositionOf(tocItem)
    if (pos === undefined) continue

    const startIndex = content.findIndex((c) => c.page >= pos)
    if (startIndex !== -1) actualProcessableCount++
  }

  const bar = createProgressBar(actualProcessableCount)

  let output = `# ${title}

By ${authors.join(', ')}

---

## Table of Contents

${metadata.toc
  .filter((tocItem) => tocPositionOf(tocItem) !== undefined)
  .map(
    (tocItem) =>
      `- [${tocItem.title}](#${tocItem.title.toLowerCase().replaceAll(/[^\da-z]+/g, '-')})`
  )
  .join('\n')}

---`

  for (let i = 0; i < metadata.toc.length; i++) {
    const tocItem = metadata.toc[i]!
    const pos = tocPositionOf(tocItem)
    if (pos === undefined) continue

    // The last TOC entry has no following item, so its section runs to the end
    // of the content. Iterating only up to `length - 1` dropped this final
    // section entirely (e.g. the last chapter + the book's conclusion).
    const nextTocItem = metadata.toc[i + 1]
    const nextPos = nextTocItem ? tocPositionOf(nextTocItem) : undefined
    const startIndex = content.findIndex((c) => c.page >= pos)
    const endIndex =
      nextPos !== undefined
        ? content.findIndex((c) => c.page >= nextPos)
        : content.length

    if (startIndex === -1) continue

    const chunks = content.slice(startIndex, endIndex)

    const text = joinChunksDedupingOverlap(chunks, ' ').replaceAll('\n', '\n\n')

    output += `

## ${tocItem.title}

${text}`

    bar.tick(1)
  }

  progressBarNewline()

  const safeTitle = sanitizeDirname(
    title || pdfBasename || path.basename(outDir)
  )
  const markdownPath = path.join(outDir, `${safeTitle}.md`)

  await fs.writeFile(markdownPath, output)
  console.log(`Export complete. Wrote markdown to: ${markdownPath}`)
  console.log(`TOC sections processed: ${actualProcessableCount}`)

  return {
    markdownPath,
    mode: 'kindle',
    sectionsProcessed: actualProcessableCount
  }
}

async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior of falling back to ASIN from .env.
  const arg = process.argv[2] ?? getEnv('ASIN')
  assert(arg, 'ASIN is required')
  const target = await resolveBookTarget(arg)
  const pdfBasename =
    target.kind === 'pdf' || target.kind === 'epub'
      ? target.basename
      : undefined

  await exportBookMarkdown({ outDir: target.outDir, pdfBasename })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr — the console is redirected to the log file.
    reportFatalError('Markdown export failed', err)
    process.exit(1)
  }
}
