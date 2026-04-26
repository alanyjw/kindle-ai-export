import { describe, expect, it } from 'vitest'

import { parseScreenshotFilename } from '../utils'

describe('parseScreenshotFilename', () => {
  it('parses 3-digit padded filenames', () => {
    expect(parseScreenshotFilename('281-221.png')).toEqual({
      index: 281,
      page: 221
    })
    expect(parseScreenshotFilename('000-001.png')).toEqual({
      index: 0,
      page: 1
    })
  })

  it('parses 4-digit padded filenames', () => {
    expect(parseScreenshotFilename('0000-0001.png')).toEqual({
      index: 0,
      page: 1
    })
    expect(parseScreenshotFilename('0123-0456.png')).toEqual({
      index: 123,
      page: 456
    })
  })

  it('parses filenames with directory prefixes', () => {
    expect(parseScreenshotFilename('out/BOOK_DIR/pages/281-221.png')).toEqual({
      index: 281,
      page: 221
    })
  })

  it('regression: does NOT truncate multi-digit indices', () => {
    // Previously `/\d*-?(\d+)-(\d+)\.png$/` captured index=1 here.
    const parsed = parseScreenshotFilename('281-221.png')
    expect(parsed?.index).toBe(281)
    expect(parsed?.index).not.toBe(1)
  })

  it('returns null for non-matching filenames', () => {
    expect(parseScreenshotFilename('cover.png')).toBeNull()
    expect(parseScreenshotFilename('281-221.jpg')).toBeNull()
    expect(parseScreenshotFilename('281.png')).toBeNull()
    expect(parseScreenshotFilename('')).toBeNull()
  })
})
