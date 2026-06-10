import { describe, expect, it } from 'vitest'

import { parseTitlePageJson } from '../title-page-extractor-openai'
import {
  recoverMetaFromTitlePage,
  selectTitlePageScreenshots,
  type TitlePageExtractor,
  type TitlePageMeta
} from '../title-page-meta'

function pages(screenshots: string[]) {
  return {
    pages: screenshots.map((screenshot, i) => ({
      index: i,
      page: i + 1,
      total: screenshots.length,
      screenshot
    }))
  }
}

// An extractor that returns a fixed result and records the images it received.
function fakeExtractor(
  result: TitlePageMeta | null | (() => Promise<TitlePageMeta | null>)
): TitlePageExtractor & { received: Buffer[][] } {
  const received: Buffer[][] = []
  return {
    received,
    async extract(images: Buffer[]) {
      received.push(images)
      return typeof result === 'function' ? result() : result
    }
  }
}

const loadAll = (paths: string[]) =>
  Promise.all(paths.map((p) => Buffer.from(`img:${p}`)))

describe('selectTitlePageScreenshots', () => {
  it('returns the first N screenshots', () => {
    const sel = selectTitlePageScreenshots(
      pages(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']),
      3
    )
    expect(sel).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('skips empty screenshot paths and tolerates short books', () => {
    const sel = selectTitlePageScreenshots(pages(['a.png', '']), 4)
    expect(sel).toEqual(['a.png'])
  })

  it('returns [] when there are no pages', () => {
    expect(selectTitlePageScreenshots({ pages: [] })).toEqual([])
  })
})

describe('recoverMetaFromTitlePage', () => {
  it('returns normalized title/authors from the extractor', async () => {
    const extractor = fakeExtractor({
      title: '  On Writing Well  ',
      authorList: [' William Zinsser ', '']
    })

    const { meta, warnings } = await recoverMetaFromTitlePage(
      pages(['cover.png', 'title.png']),
      loadAll,
      extractor
    )

    expect(meta.title).toBe('On Writing Well')
    expect(meta.authorList).toEqual(['William Zinsser'])
    expect(warnings).toEqual([])
    // The extractor was handed the loaded image buffers.
    expect(extractor.received[0]).toHaveLength(2)
  })

  it('warns when there are no screenshots', async () => {
    const extractor = fakeExtractor({ title: 'X' })
    const { meta, warnings } = await recoverMetaFromTitlePage(
      { pages: [] },
      loadAll,
      extractor
    )
    expect(meta).toEqual({})
    expect(warnings[0]).toContain('no page screenshots')
    expect(extractor.received).toHaveLength(0)
  })

  it('warns when the extractor finds nothing usable', async () => {
    const extractor = fakeExtractor({ title: '   ', authorList: [] })
    const { meta, warnings } = await recoverMetaFromTitlePage(
      pages(['cover.png']),
      loadAll,
      extractor
    )
    expect(meta).toEqual({})
    expect(warnings[0]).toContain('did not yield')
  })

  it('warns (and does not throw) when image loading fails', async () => {
    const extractor = fakeExtractor({ title: 'X' })
    const { meta, warnings } = await recoverMetaFromTitlePage(
      pages(['cover.png']),
      () => Promise.reject(new Error('ENOENT')),
      extractor
    )
    expect(meta).toEqual({})
    expect(warnings[0]).toContain('failed to read')
  })

  it('warns (and does not throw) when the extractor throws', async () => {
    const extractor = fakeExtractor(() =>
      Promise.reject(new Error('rate limited'))
    )
    const { meta, warnings } = await recoverMetaFromTitlePage(
      pages(['cover.png']),
      loadAll,
      extractor
    )
    expect(meta).toEqual({})
    expect(warnings[0]).toContain('extraction failed')
    expect(warnings[0]).toContain('rate limited')
  })

  it('keeps a title even when no authors are found', async () => {
    const extractor = fakeExtractor({ title: 'Solo Title', authorList: [] })
    const { meta } = await recoverMetaFromTitlePage(
      pages(['cover.png']),
      loadAll,
      extractor
    )
    expect(meta.title).toBe('Solo Title')
    expect(meta.authorList).toEqual([])
  })
})

describe('parseTitlePageJson', () => {
  it('parses a plain JSON object', () => {
    expect(
      parseTitlePageJson(
        '{"title":"On Writing Well","authorList":["William Zinsser"]}'
      )
    ).toEqual({ title: 'On Writing Well', authorList: ['William Zinsser'] })
  })

  it('parses JSON wrapped in a ```json fence with prose around it', () => {
    const raw =
      'Here is the result:\n```json\n{"title":"T","authorList":["A","B"]}\n```\n'
    expect(parseTitlePageJson(raw)).toEqual({
      title: 'T',
      authorList: ['A', 'B']
    })
  })

  it('treats a null/blank title as undefined', () => {
    expect(parseTitlePageJson('{"title":null,"authorList":[]}')).toEqual({
      title: undefined,
      authorList: []
    })
  })

  it('drops non-string authors', () => {
    expect(
      parseTitlePageJson('{"title":"T","authorList":["A",5,null,"B"]}')
    ).toEqual({ title: 'T', authorList: ['A', 'B'] })
  })

  it('returns null when there is no JSON object', () => {
    expect(parseTitlePageJson('no json here')).toBeNull()
  })
})
