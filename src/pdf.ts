import fs from 'node:fs/promises'
import path from 'node:path'

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

export async function closePdfRenderer(pdfPath: string): Promise<void> {
  // Kept for API compatibility with callers; Node rendering doesn't hold external resources.
  void pdfPath
}
