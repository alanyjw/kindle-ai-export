import { describe, expect, it } from 'vitest'

import { flattenPdfOutline } from '../pdf-outline'
import type { PdfOutlineNode } from '../pdf-outline'

const total = 100

describe('flattenPdfOutline', () => {
  it('flattens a nested outline depth-first, tagging nesting level', () => {
    const nodes: PdfOutlineNode[] = [
      { title: 'Introduction', page: 2 },
      {
        title: 'PART I | BEGINNINGS',
        page: 10,
        items: [
          { title: '1 | First Steps', page: 11 },
          { title: '2 | Second Steps', page: 20 }
        ]
      },
      {
        title: 'PART II | ENDINGS',
        page: 30,
        items: [{ title: '3 | Third Steps', page: 31 }]
      }
    ]

    expect(flattenPdfOutline(nodes, { totalPages: total })).toEqual([
      { title: 'Introduction', page: 2, level: 0, total },
      { title: 'PART I | BEGINNINGS', page: 10, level: 0, total },
      { title: '1 | First Steps', page: 11, level: 1, total },
      { title: '2 | Second Steps', page: 20, level: 1, total },
      { title: 'PART II | ENDINGS', page: 30, level: 0, total },
      { title: '3 | Third Steps', page: 31, level: 1, total }
    ])
  })

  it('drops entries whose destination did not resolve, but keeps their children', () => {
    const nodes: PdfOutlineNode[] = [
      {
        title: 'Unresolvable Part',
        items: [{ title: 'Chapter 1', page: 5 }]
      }
    ]

    expect(flattenPdfOutline(nodes, { totalPages: total })).toEqual([
      { title: 'Chapter 1', page: 5, level: 1, total }
    ])
  })

  it('ignores entries with blank titles and trims surrounding whitespace', () => {
    const nodes: PdfOutlineNode[] = [
      { title: '   ', page: 3 },
      { title: '  Chapter 1\n', page: 4 }
    ]

    expect(flattenPdfOutline(nodes, { totalPages: total })).toEqual([
      { title: 'Chapter 1', page: 4, level: 0, total }
    ])
  })

  it('sorts by page while preserving outline order for entries on the same page', () => {
    const nodes: PdfOutlineNode[] = [
      { title: 'Later', page: 40 },
      {
        title: 'PART I | BEGINNINGS',
        page: 10,
        items: [{ title: '1 | First Steps', page: 10 }]
      }
    ]

    expect(
      flattenPdfOutline(nodes, { totalPages: total }).map((t) => t.title)
    ).toEqual(['PART I | BEGINNINGS', '1 | First Steps', 'Later'])
  })

  it('clamps nesting deeper than maxLevel so headings stay renderable', () => {
    const nodes: PdfOutlineNode[] = [
      {
        title: 'Level 0',
        page: 1,
        items: [
          {
            title: 'Level 1',
            page: 2,
            items: [{ title: 'Level 2', page: 3 }]
          }
        ]
      }
    ]

    expect(
      flattenPdfOutline(nodes, { totalPages: total, maxLevel: 1 }).map(
        (t) => t.level
      )
    ).toEqual([0, 1, 1])
  })

  it('returns an empty list for a missing or empty outline', () => {
    expect(flattenPdfOutline(undefined, { totalPages: total })).toEqual([])
    expect(flattenPdfOutline([], { totalPages: total })).toEqual([])
  })

  it('ignores pages outside the document', () => {
    const nodes: PdfOutlineNode[] = [
      { title: 'Bad Low', page: 0 },
      { title: 'Bad High', page: 101 },
      { title: 'Good', page: 100 }
    ]

    expect(
      flattenPdfOutline(nodes, { totalPages: total }).map((t) => t.title)
    ).toEqual(['Good'])
  })
})
