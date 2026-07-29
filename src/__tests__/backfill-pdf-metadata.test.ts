import { describe, expect, it } from 'vitest'

import { pdfPathFromContent } from '../backfill-pdf-metadata'

describe('pdfPathFromContent', () => {
  it('recovers the source PDF path from a chunk provenance marker', () => {
    expect(
      pdfPathFromContent([
        { screenshot: 'pdf:/books/example.pdf#page=1' },
        { screenshot: 'pdf:/books/example.pdf#page=2' }
      ])
    ).toBe('/books/example.pdf')
  })

  it('handles paths containing spaces and punctuation', () => {
    expect(
      pdfPathFromContent([
        {
          screenshot:
            'pdf:/Users/someone/Downloads/Example Book - Author.pdf#page=12'
        }
      ])
    ).toBe('/Users/someone/Downloads/Example Book - Author.pdf')
  })

  it('only strips a trailing page fragment, not one inside the name', () => {
    expect(
      pdfPathFromContent([
        { screenshot: 'pdf:/books/vol#page=2 draft.pdf#page=7' }
      ])
    ).toBe('/books/vol#page=2 draft.pdf')
  })

  it('skips leading non-PDF chunks', () => {
    expect(
      pdfPathFromContent([
        { screenshot: '0000-0001.png' },
        { screenshot: 'pdf:/books/example.pdf#page=3' }
      ])
    ).toBe('/books/example.pdf')
  })

  it('returns undefined for Kindle screenshots and EPUB sections', () => {
    expect(
      pdfPathFromContent([{ screenshot: '0000-0001.png' }])
    ).toBeUndefined()
    expect(
      pdfPathFromContent([{ screenshot: 'epub:chapter-1' }])
    ).toBeUndefined()
    expect(pdfPathFromContent([])).toBeUndefined()
  })

  it('ignores a marker with no path after the scheme', () => {
    expect(pdfPathFromContent([{ screenshot: 'pdf:' }])).toBeUndefined()
  })
})
