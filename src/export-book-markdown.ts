import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BookMetadata, ContentChunk } from './types'
import {
  assert,
  createProgressBar,
  fileExists,
  getEnv,
  progressBarNewline,
  resolveOutDir,
  sanitizeDirname,
  setupTimestampedLogger
} from './utils'

function stripOcrBoilerplate(text: string): string {
  const boilerplateLineMatchers: RegExp[] = [
    /i['’]m sorry.*(image|uploaded|visible)/i,
    /\bi (can|can't|cannot)\b.*\b(help|assist)\b.*\b(image|uploaded)\b/i,
    /\bi['’]m unable to\b.*\b(help|view|analyze)\b.*\b(image|uploaded)\b/i,
    /\bi can'?t identify\b.*\bpeople\b.*\bimages?\b/i,
    /could you please (try again|provide|describe)/i,
    /i (can|can't|cannot) (identify|provide information about).*people in images/i
  ]

  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const kept = lines.filter((line) => {
    const t = line.trim()
    if (!t) return true
    return !boilerplateLineMatchers.some((re) => re.test(t))
  })

  return kept
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

function formatPdfTextToMarkdown(body: string): string {
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

    if (/^part\b/i.test(cleanedLine)) {
      const { heading, rest } = splitHeadingAndRest(cleanedLine, 'part')
      pushBlank()
      out.push(`## ${heading}`)
      out.push('')
      if (rest) out.push(rest)
      continue
    }

    if (/^chapter\s+\d+\b/i.test(cleanedLine)) {
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

  // PDF / content-only mode (no metadata.json)
  if (!hasMetadata) {
    const title = pdfBasename || path.basename(outDir)
    const safeTitle = sanitizeDirname(title)

    const sorted = [...content].sort(
      (a, b) => a.page - b.page || a.index - b.index
    )

    const bar = createProgressBar(sorted.length)

    const body = sorted
      .map((chunk) => {
        bar.tick(1)
        return stripOcrBoilerplate(chunk.text)
      })
      .join('\n\n')

    progressBarNewline()

    const formattedBody = formatPdfTextToMarkdown(body)
    const output = `# ${title}\n\n${formattedBody}\n`
    const markdownPath = path.join(outDir, `${safeTitle}.md`)
    await fs.writeFile(markdownPath, output)
    console.log(`Export complete. Wrote markdown to: ${markdownPath}`)
    console.log(`Pages processed: ${sorted.length}`)
    return {
      markdownPath,
      mode: 'content-only',
      pagesProcessed: sorted.length
    }
  }

  // Kindle mode (existing)
  const metadata = JSON.parse(
    await fs.readFile(metadataPath, 'utf8')
  ) as BookMetadata
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  // Detect location-mode by majority — mirrors the extract pipeline. Hybrid
  // books like reflowable text with one stray back-matter page entry are
  // dominated by location entries and should be treated as location-mode.
  const tocPageCount = metadata.toc.filter(
    (i) => i.page !== undefined
  ).length
  const tocLocationCount = metadata.toc.filter(
    (i) => i.location !== undefined
  ).length
  const useLocationMode = tocLocationCount > tocPageCount
  const tocPositionOf = (item: { page?: number; location?: number }) =>
    useLocationMode ? item.location : item.page

  // Count actual items that will be processed (have positions and can find content)
  let actualProcessableCount = 0
  for (let i = 0; i < metadata.toc.length - 1; i++) {
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

  for (let i = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    const pos = tocPositionOf(tocItem)
    if (pos === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextPos = tocPositionOf(nextTocItem)
    const startIndex = content.findIndex((c) => c.page >= pos)
    const endIndex =
      nextPos !== undefined
        ? content.findIndex((c) => c.page >= nextPos)
        : content.length

    if (startIndex === -1) continue

    const chunks = content.slice(startIndex, endIndex)

    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replaceAll('\n', '\n\n')

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
  const arg = process.argv[2]

  let outDir: string
  let pdfBasename: string | undefined

  if (arg) {
    if (/\.pdf$/i.test(arg)) {
      const pdfPath = path.resolve(arg)
      pdfBasename = sanitizeDirname(
        path.basename(pdfPath, path.extname(pdfPath))
      )
      outDir = path.join('out', pdfBasename)
    } else {
      outDir = path.resolve(arg)
    }
  } else {
    const asin = getEnv('ASIN')
    assert(asin, 'ASIN is required')
    outDir = await resolveOutDir(asin)
  }

  await exportBookMarkdown({ outDir, pdfBasename })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
