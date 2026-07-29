import fs from 'node:fs/promises'
import path from 'node:path'

import type { PdfOutlineNode } from './pdf-outline'

type PdfDocument = any

const pdfDocCache = new Map<string, Promise<PdfDocument>>()

async function loadPdfJs(): Promise<any> {
  // pdfjs-dist moved paths across major versions; support both.
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch {
    return await import('pdfjs-dist/build/pdf.mjs')
  }
}

async function loadPdfDocument(pdfPath: string): Promise<PdfDocument> {
  const absPath = path.resolve(pdfPath)
  let cached = pdfDocCache.get(absPath)
  if (!cached) {
    cached = (async () => {
      const pdfjsMod: any = await loadPdfJs()
      const pdfjs: any = pdfjsMod?.getDocument ? pdfjsMod : pdfjsMod?.default

      const data = new Uint8Array(await fs.readFile(absPath))
      const loadingTask = pdfjs.getDocument({ data, disableWorker: true })
      return await loadingTask.promise
    })()

    pdfDocCache.set(absPath, cached)
  }

  return await cached
}

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const doc = await loadPdfDocument(pdfPath)
  return Number(doc.numPages)
}

export async function extractPdfPageText(
  pdfPath: string,
  pageNumber: number
): Promise<string> {
  const doc = await loadPdfDocument(pdfPath)
  const page = await doc.getPage(pageNumber)
  const textContent = await page.getTextContent()
  const items: any[] = Array.isArray(textContent?.items)
    ? textContent.items
    : []

  // Keep it simple: PDF text extraction often produces broken line breaks; joining
  // with spaces is usually the least-worst default.
  return items
    .map((it) => (typeof it?.str === 'string' ? it.str : ''))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * Read the PDF's embedded outline (bookmarks), resolving each entry's
 * destination to a 1-based page number.
 *
 * Most published ebooks ship a complete outline — it's the only trustworthy
 * table of contents available from a PDF, since the extracted text layer
 * carries no heading structure at all. Entries whose destination can't be
 * resolved are returned with `page: undefined` rather than dropped, so callers
 * can still descend into their children.
 */
export async function getPdfOutline(
  pdfPath: string
): Promise<PdfOutlineNode[]> {
  const doc = await loadPdfDocument(pdfPath)
  const rawOutline = await doc.getOutline().catch(() => null)
  if (!Array.isArray(rawOutline)) return []

  const pageOf = async (dest: any): Promise<number | undefined> => {
    try {
      const resolved =
        typeof dest === 'string' ? await doc.getDestination(dest) : dest
      if (!Array.isArray(resolved) || resolved.length === 0) return undefined
      const pageIndex = await doc.getPageIndex(resolved[0])
      return typeof pageIndex === 'number' ? pageIndex + 1 : undefined
    } catch {
      // A malformed or dangling destination shouldn't sink the whole outline.
      return undefined
    }
  }

  const convert = async (nodes: any[]): Promise<PdfOutlineNode[]> =>
    Promise.all(
      nodes.map(async (node) => ({
        title: typeof node?.title === 'string' ? node.title : '',
        page: await pageOf(node?.dest),
        items: Array.isArray(node?.items) ? await convert(node.items) : []
      }))
    )

  return convert(rawOutline)
}

export async function renderPdfPageToPngBuffer(
  pdfPath: string,
  pageNumber: number
): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const doc = await loadPdfDocument(pdfPath)
  const page = await doc.getPage(pageNumber)

  // A moderate scale tends to OCR well without being too expensive.
  const viewport = page.getViewport({ scale: 2 })
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height)
  )
  const ctx = canvas.getContext('2d')

  const renderTask = page.render({
    canvasContext: ctx as any,
    viewport
  })

  await renderTask.promise
  return canvas.toBuffer('image/png')
}

/**
 * Release a cached PDF document.
 *
 * `loadPdfDocument` memoizes by path and never evicts, which is fine for the
 * single-book scripts but unbounded when a batch job walks a whole library —
 * each entry pins the file bytes plus pdfjs' parsed structures. Callers that
 * loop over many PDFs should close each one when done.
 */
export async function closePdfRenderer(pdfPath: string): Promise<void> {
  const absPath = path.resolve(pdfPath)
  const cached = pdfDocCache.get(absPath)
  if (!cached) return

  pdfDocCache.delete(absPath)
  try {
    const doc = await cached
    await doc?.destroy?.()
  } catch {
    // A document that failed to load has nothing to release.
  }
}
