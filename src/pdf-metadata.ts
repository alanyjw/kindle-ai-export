import { flattenPdfOutline } from './pdf-outline'
import type { PdfOutlineNode } from './pdf-outline'
import type { BookMetadata, PageChunk } from './types'

/**
 * The PDF facts `buildPdfMetadata` needs, injected so the shaping logic stays
 * testable without a real document.
 */
export interface PdfMetadataSource {
  getPageCount(pdfPath: string): Promise<number>
  getOutline(pdfPath: string): Promise<PdfOutlineNode[]>
}

/**
 * Build a `metadata.json` payload for a PDF from its embedded outline.
 *
 * A PDF's text layer carries no heading structure — `extractPdfPageText`
 * flattens each page to a single line — so the outline is the only reliable
 * source of chapter boundaries. Turning it into a `toc` is what lets the
 * exporters emit real markdown headings instead of guessing from text shape.
 *
 * Returns `undefined` when the PDF has no usable outline; callers should then
 * skip writing metadata rather than emit a `toc`-less file that the exporters
 * assert on.
 */
export async function buildPdfMetadata(
  pdfPath: string,
  source: PdfMetadataSource
): Promise<BookMetadata | undefined> {
  const totalPages = await source.getPageCount(pdfPath)
  if (!Number.isInteger(totalPages) || totalPages < 1) return undefined

  const outline = await source.getOutline(pdfPath).catch(() => [])
  const toc = flattenPdfOutline(outline, { totalPages })
  if (toc.length === 0) return undefined

  const pages: PageChunk[] = Array.from({ length: totalPages }, (_, i) => ({
    index: i,
    page: i + 1,
    total: totalPages,
    screenshot: `pdf:${pdfPath}#page=${i + 1}`
  }))

  // No `meta`/`info`: those come from Amazon's reader APIs, which have no
  // analogue here. `resolveBookMeta()` derives a title from the out-dir.
  return { source: 'pdf', toc, pages }
}
