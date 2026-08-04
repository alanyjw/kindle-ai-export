import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import PDFDocument from 'pdfkit'

import { resolveBookMeta } from './book-meta'
import { resolveBookTarget } from './book-input'
import type { BookMetadata, ContentChunk } from './types'
import { assert, getEnv, reportFatalError } from './utils'

export interface ExportBookPdfOptions {
  outDir: string
}

export async function exportBookPdf(
  opts: ExportBookPdfOptions
): Promise<{ pdfPath: string }> {
  const { outDir } = opts

  const content = JSON.parse(
    await fsp.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  const metadata = JSON.parse(
    await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(content.length, 'no book content found')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  // Degrade gracefully when `meta` is missing (e.g. Amazon 403'd the reader
  // metadata API during extraction) rather than hard-failing the export.
  const resolved = resolveBookMeta(metadata, outDir)
  if (resolved.warning) {
    console.warn(resolved.warning)
  }
  const title = resolved.title
  const authors = resolved.authorList

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: authors.join(', ')
    }
  })
  const pdfPath = path.join(outDir, 'book.pdf')
  const stream = doc.pipe(fs.createWriteStream(pdfPath))

  const fontSize = 12

  const renderTitlePage = () => {
    ;(doc as any).outline.addItem('Title Page')
    doc.fontSize(48)
    doc.y = doc.page.height / 2 - doc.heightOfString(title) / 2
    doc.text(title, { align: 'center' })
    const w = doc.widthOfString(title)

    const byline = `By ${authors.join(',\n')}`

    doc.fontSize(20)
    doc.y -= doc.heightOfString(byline) / 2
    doc.text(byline, {
      align: 'center',
      indent: w - doc.widthOfString(byline)
    })

    doc.addPage()
    doc.fontSize(fontSize)
  }

  renderTitlePage()

  let needsNewPage = false
  let index = 0

  for (let i = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    if (needsNewPage) {
      doc.addPage()
    }

    // Aggregate all of the chunks in this chapter into a single string.
    const chunks = content.slice(index, nextIndex)
    const text = chunks.map((chunk) => chunk.text).join(' ')

    ;(doc as any).outline.addItem(tocItem.title)
    doc.fontSize(20)
    doc.text(tocItem.title, { align: 'center', lineGap: 16 })

    doc.fontSize(fontSize)
    doc.moveDown(1)

    doc.text(text, {
      indent: 20,
      lineGap: 4,
      paragraphGap: 8
    })

    index = nextIndex
    needsNewPage = true
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve())
    stream.on('error', (err) => reject(err))
  })

  return { pdfPath }
}

async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior of falling back to ASIN from .env.
  const arg = process.argv[2] ?? getEnv('ASIN')
  assert(arg, 'ASIN is required')
  const target = await resolveBookTarget(arg)
  await exportBookPdf({ outDir: target.outDir })
}

// Only auto-run when invoked directly, so importing this module (from book.ts
// or a test) doesn't kick off a PDF export.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr and exit non-zero so a `&&` chain stops here.
    reportFatalError('PDF export failed', err)
    process.exit(1)
  }
}
