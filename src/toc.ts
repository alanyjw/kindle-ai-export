import type { TocItem } from './types'
import { assert } from './utils'

/**
 * A reader position as parsed from the Kindle reader footer. Page-mode books
 * expose `page`; reflowable/location-mode books expose `location`. `total` is
 * the book's last position in whichever mode is active.
 */
export interface PageNav {
  page?: number
  location?: number
  total: number
}

/**
 * Whether two footer readings refer to the same reader position. Used to detect
 * whether the reader has actually navigated after a TOC click (vs. a stale
 * footer that hasn't updated yet). `undefined` never equals another reading, so
 * an unparseable footer keeps the caller polling until it settles.
 */
export function samePageNav(
  a: PageNav | undefined,
  b: PageNav | undefined
): boolean {
  if (a === undefined || b === undefined) return false
  return a.page === b.page && a.location === b.location && a.total === b.total
}

export interface ParsedToc<T extends TocItem> {
  firstPageTocItem: T
  afterLastPageTocItem: T | undefined
  useLocationMode: boolean
  firstContentPosition: number
  afterLastContentPosition: number | undefined
}

/**
 * Resolve the start and end of a book's main content from its parsed TOC.
 *
 * Generic over the concrete TOC item type so callers can carry extra fields
 * (e.g. a Playwright `Locator`) through the result without this module
 * depending on the browser layer.
 */
export function parseTocItems<T extends TocItem>(tocItems: T[]): ParsedToc<T> {
  // Some Kindle books expose page numbers in the reader footer; reflowable
  // text books only expose locations. Detect by majority: front matter (Cover,
  // Title Page, etc.) often only reports location even in page-mode books, so
  // we can't just inspect the first TOC item. Conversely, some location-only
  // books carry one stray back-matter entry with a publisher page number from
  // a separate pagination scheme. Prefer location mode only when locations
  // strictly outnumber pages.
  const pageCount = tocItems.filter((i) => i.page !== undefined).length
  const locationCount = tocItems.filter((i) => i.location !== undefined).length
  const useLocationMode = locationCount > pageCount

  const positionOf = (item: T): number | undefined =>
    useLocationMode ? item.location : item.page

  // Find the first TOC entry with the active position type — this is the
  // start of the main book content (after title/TOC/copyright).
  //
  // Skip a leading entry whose position is the book's very last page: a content
  // section can never legitimately begin on the final page. Such an entry is a
  // stale footer reading — most often the cover, which renders no footer page
  // indicator, so the footer retains whatever position the reader was resumed to
  // (e.g. the *last* page when a "Most Recent Page Read" sync from another
  // device jumped it there). Without this guard that stale `page === total`
  // becomes the content start and the main loop has zero pages to read. Fall
  // back to the first positioned entry so degenerate single-position TOCs still
  // resolve.
  const positionedTocItems = tocItems.filter(
    (item) => positionOf(item) !== undefined
  )
  const firstPageTocItem =
    positionedTocItems.find((item) => positionOf(item)! < item.total) ??
    positionedTocItems[0]
  assert(
    firstPageTocItem,
    `Unable to find first valid TOC item (location-mode: ${useLocationMode})`
  )

  // Try to find the first TOC entry AFTER the main book content (back matter:
  // acknowledgements, about the author, etc).
  const afterLastPageTocItem = tocItems.find((item) => {
    const pos = positionOf(item)
    if (pos === undefined) return false
    if (item === firstPageTocItem) return false

    const percentage = pos / item.total
    if (percentage < 0.9) return false

    if (/acknowledgements/i.test(item.title)) return true
    if (/^discover more$/i.test(item.title)) return true
    if (/^extras$/i.test(item.title)) return true
    if (/about the author/i.test(item.title)) return true
    if (/meet the author/i.test(item.title)) return true
    if (/^also by /i.test(item.title)) return true
    if (/^copyright$/i.test(item.title)) return true
    if (/ teaser$/i.test(item.title)) return true
    if (/ preview$/i.test(item.title)) return true
    if (/^excerpt from/i.test(item.title)) return true
    if (/^cast of characters$/i.test(item.title)) return true
    if (/^timeline$/i.test(item.title)) return true
    if (/^other titles/i.test(item.title)) return true

    return false
  })

  return {
    firstPageTocItem,
    afterLastPageTocItem,
    useLocationMode,
    firstContentPosition: positionOf(firstPageTocItem)!,
    afterLastContentPosition: afterLastPageTocItem
      ? positionOf(afterLastPageTocItem)
      : undefined
  }
}
