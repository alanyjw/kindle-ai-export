import { describe, expect, it } from 'vitest'

import { buildPdfMetadata } from '../pdf-metadata'
import type { PdfMetadataSource } from '../pdf-metadata'
import type { PdfOutlineNode } from '../pdf-outline'

function source(
  totalPages: number,
  outline: PdfOutlineNode[] | (() => Promise<PdfOutlineNode[]>)
): PdfMetadataSource {
  return {
    getPageCount: async () => totalPages,
    getOutline: typeof outline === 'function' ? outline : async () => outline
  }
}

describe('buildPdfMetadata', () => {
  it('shapes the outline into a levelled toc plus per-page entries', async () => {
    const metadata = await buildPdfMetadata(
      '/books/example.pdf',
      source(3, [
        {
          title: 'PART I | BEGINNINGS',
          page: 1,
          items: [{ title: '1 | First Steps', page: 2 }]
        }
      ])
    )

    expect(metadata?.source).toBe('pdf')
    expect(metadata?.toc).toEqual([
      { title: 'PART I | BEGINNINGS', page: 1, level: 0, total: 3 },
      { title: '1 | First Steps', page: 2, level: 1, total: 3 }
    ])
    expect(metadata?.pages).toHaveLength(3)
    expect(metadata?.pages[0]).toEqual({
      index: 0,
      page: 1,
      total: 3,
      screenshot: 'pdf:/books/example.pdf#page=1'
    })
  })

  it('omits meta/info, which have no PDF analogue', async () => {
    const metadata = await buildPdfMetadata(
      '/books/example.pdf',
      source(2, [{ title: 'Chapter 1', page: 1 }])
    )

    expect(metadata?.meta).toBeUndefined()
    expect(metadata?.info).toBeUndefined()
  })

  it('returns undefined when the PDF has no outline', async () => {
    expect(
      await buildPdfMetadata('/books/example.pdf', source(5, []))
    ).toBeUndefined()
  })

  it('returns undefined when no outline entry resolves to a page', async () => {
    expect(
      await buildPdfMetadata(
        '/books/example.pdf',
        source(5, [{ title: 'Dangling', page: undefined }])
      )
    ).toBeUndefined()
  })

  it('returns undefined rather than throwing when reading the outline fails', async () => {
    expect(
      await buildPdfMetadata(
        '/books/example.pdf',
        source(5, async () => {
          throw new Error('corrupt outline')
        })
      )
    ).toBeUndefined()
  })

  it('returns undefined for an empty document', async () => {
    expect(
      await buildPdfMetadata(
        '/books/example.pdf',
        source(0, [{ title: 'Chapter 1', page: 1 }])
      )
    ).toBeUndefined()
  })
})
