import type { BookMetadata } from './types'

export interface TitlePageMeta {
  title?: string
  authorList?: string[]
}

// Extracts a book's title/author from page images (the cover/title page). The
// implementation hits a vision model; injected here so the orchestration below
// is testable without network. Returns null when nothing could be determined.
export interface TitlePageExtractor {
  extract(images: Buffer[]): Promise<TitlePageMeta | null>
}

export interface RecoverFromTitlePageResult {
  meta: TitlePageMeta
  warnings: string[]
}

// Pick the screenshots most likely to show the title/author. Front matter
// (cover, title page, copyright) is always at the very start of the capture
// regardless of page- vs location-mode, so the first few pages are the reliable
// signal — no TOC-position alignment needed. Pure + testable.
export function selectTitlePageScreenshots(
  metadata: Pick<BookMetadata, 'pages'>,
  maxPages = 4
): string[] {
  const pages = metadata.pages ?? []
  return pages
    .slice(0, Math.max(0, maxPages))
    .map((p) => p.screenshot)
    .filter((s): s is string => Boolean(s))
}

// Recover { title, authorList } from the book's own title page using already
// captured screenshots. Account-independent (no Amazon API) — the title and
// author are printed on the page. Pure orchestration over an injected image
// loader + extractor; the caller logs the returned warnings.
export async function recoverMetaFromTitlePage(
  metadata: Pick<BookMetadata, 'pages'>,
  loadImages: (paths: string[]) => Promise<Buffer[]>,
  extractor: TitlePageExtractor,
  opts: { maxPages?: number } = {}
): Promise<RecoverFromTitlePageResult> {
  const warnings: string[] = []

  const paths = selectTitlePageScreenshots(metadata, opts.maxPages ?? 4)
  if (paths.length === 0) {
    warnings.push('no page screenshots available for title-page extraction')
    return { meta: {}, warnings }
  }

  let images: Buffer[]
  try {
    images = await loadImages(paths)
  } catch (err) {
    warnings.push(
      `failed to read title-page screenshots: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { meta: {}, warnings }
  }
  if (images.length === 0) {
    warnings.push('title-page screenshots could not be loaded')
    return { meta: {}, warnings }
  }

  let extracted: TitlePageMeta | null
  try {
    extracted = await extractor.extract(images)
  } catch (err) {
    warnings.push(
      `title-page extraction failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { meta: {}, warnings }
  }

  const title =
    typeof extracted?.title === 'string' && extracted.title.trim()
      ? extracted.title.trim()
      : undefined
  const authorList = Array.isArray(extracted?.authorList)
    ? extracted.authorList
        .map((a) => (typeof a === 'string' ? a.trim() : ''))
        .filter(Boolean)
    : []

  if (!title && authorList.length === 0) {
    warnings.push('title page did not yield a title or author')
    return { meta: {}, warnings }
  }

  return { meta: { title, authorList }, warnings }
}
