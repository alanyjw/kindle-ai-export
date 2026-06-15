import { describe, expect, it } from 'vitest'

import { parseTocItems, samePageNav } from '../toc'
import type { TocItem } from '../types'

describe('parseTocItems', () => {
  it('regression: skips a stale cover stuck on the book’s last page', () => {
    // Real failure mode: another session left the book on its last page,
    // Amazon’s "Most Recent Page Read" sync resumed there, and the cover —
    // which renders no footer page indicator — reported the stale
    // `page 254 of 254`. Picking the first positioned entry made the cover the
    // content start, leaving the main loop 0 pages to read.
    const tocItems: TocItem[] = [
      { title: 'Cover', page: 254, total: 254 }, // stale footer reading
      { title: 'Contents', location: 32, total: 3433 },
      { title: 'Opening Section', page: 7, total: 254 },
      { title: 'Part 1', page: 14, total: 254 },
      { title: 'Chapter 1', page: 15, total: 254 },
      { title: 'Conclusion', page: 254, total: 254 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.useLocationMode).toBe(false)
    expect(parsed.firstPageTocItem.title).toBe('Opening Section')
    expect(parsed.firstContentPosition).toBe(7)
    // No recognised back-matter title, so the loop reads through to `total`.
    expect(parsed.afterLastContentPosition).toBeUndefined()
  })

  it('uses the first positioned entry in a normal page-mode book', () => {
    const tocItems: TocItem[] = [
      { title: 'Cover', location: 1, total: 320 }, // front matter: location only
      { title: 'Title Page', location: 3, total: 320 },
      { title: 'Chapter 1', page: 1, total: 320 },
      { title: 'Chapter 2', page: 28, total: 320 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.useLocationMode).toBe(false)
    expect(parsed.firstPageTocItem.title).toBe('Chapter 1')
    expect(parsed.firstContentPosition).toBe(1)
  })

  it('uses location mode when locations strictly outnumber pages', () => {
    const tocItems: TocItem[] = [
      { title: 'Cover', location: 1, total: 5000 },
      { title: 'Introduction', location: 120, total: 5000 },
      { title: 'Chapter 1', location: 350, total: 5000 },
      // A lone stray page number from a separate pagination scheme.
      { title: 'Index', page: 410, total: 999 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.useLocationMode).toBe(true)
    expect(parsed.firstPageTocItem.title).toBe('Cover')
    expect(parsed.firstContentPosition).toBe(1)
  })

  it('detects back matter and sets afterLastContentPosition', () => {
    const tocItems: TocItem[] = [
      { title: 'Chapter 1', page: 1, total: 300 },
      { title: 'Chapter 2', page: 40, total: 300 },
      { title: 'Acknowledgements', page: 290, total: 300 }, // >= 90%
      { title: 'About the Author', page: 298, total: 300 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.firstPageTocItem.title).toBe('Chapter 1')
    expect(parsed.afterLastPageTocItem?.title).toBe('Acknowledgements')
    expect(parsed.afterLastContentPosition).toBe(290)
  })

  it('does not treat an early back-matter-titled entry as back matter', () => {
    // "Copyright" appears at the front (< 90%), so it must not be picked as the
    // end of content.
    const tocItems: TocItem[] = [
      { title: 'Copyright', page: 2, total: 300 },
      { title: 'Chapter 1', page: 10, total: 300 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.firstPageTocItem.title).toBe('Copyright')
    expect(parsed.afterLastPageTocItem).toBeUndefined()
    expect(parsed.afterLastContentPosition).toBeUndefined()
  })

  it('falls back to the first positioned entry when every one is at total', () => {
    // Degenerate single-positioned TOC: nothing is strictly below `total`, so
    // the guard must fall back rather than fail.
    const tocItems: TocItem[] = [
      { title: 'Contents', location: 5, total: 200 },
      { title: 'Only Section', page: 200, total: 200 }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.firstPageTocItem.title).toBe('Only Section')
    expect(parsed.firstContentPosition).toBe(200)
  })

  it('preserves extra fields on items (generic passthrough)', () => {
    interface RichTocItem extends TocItem {
      locator: string
    }

    const tocItems: RichTocItem[] = [
      { title: 'Cover', page: 254, total: 254, locator: '#cover' },
      { title: 'Chapter 1', page: 7, total: 254, locator: '#ch1' }
    ]

    const parsed = parseTocItems(tocItems)

    expect(parsed.firstPageTocItem.locator).toBe('#ch1')
  })

  it('throws when no entry carries a position', () => {
    const tocItems: TocItem[] = [{ title: 'Cover', total: 254 }]

    expect(() => parseTocItems(tocItems)).toThrow(/first valid TOC item/i)
  })
})

describe('samePageNav', () => {
  it('returns true for identical page readings', () => {
    expect(samePageNav({ page: 7, total: 254 }, { page: 7, total: 254 })).toBe(
      true
    )
  })

  it('returns true for identical location readings', () => {
    expect(
      samePageNav({ location: 32, total: 3433 }, { location: 32, total: 3433 })
    ).toBe(true)
  })

  it('returns false when the position differs', () => {
    expect(samePageNav({ page: 7, total: 254 }, { page: 8, total: 254 })).toBe(
      false
    )
  })

  it('returns false when page vs location differ', () => {
    expect(
      samePageNav({ page: 7, total: 254 }, { location: 7, total: 254 })
    ).toBe(false)
  })

  it('returns false when either reading is undefined', () => {
    expect(samePageNav(undefined, { page: 7, total: 254 })).toBe(false)
    expect(samePageNav({ page: 7, total: 254 }, undefined)).toBe(false)
    expect(samePageNav(undefined, undefined)).toBe(false)
  })
})
