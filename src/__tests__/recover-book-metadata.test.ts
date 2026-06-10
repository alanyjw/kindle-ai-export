import { describe, expect, it } from 'vitest'

import {
  buildStartReadingUrl,
  cleanBookInfo,
  type FetchResult,
  type MetadataFetcher,
  parseBookMeta,
  recoverBookMetadata
} from '../recover-book-metadata'

const ASIN = 'B0090RVGW0'
const START_URL = buildStartReadingUrl(ASIN)
const METADATA_URL = 'https://m.media-amazon.com/images/book/YJmetadata.jsonp'

function startReadingBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    asin: ASIN,
    karamelToken: 'SECRET_TOKEN',
    metadataUrl: METADATA_URL,
    YJFormatVersion: 'YJ-2.0',
    contentType: 'EBOK',
    isOwned: true,
    srl: 0,
    lastPageReadData: { deviceName: 'iPhone', position: 100, syncTime: 1 },
    ...overrides
  })
}

function metadataJsonp(overrides: Record<string, unknown> = {}): string {
  const obj = {
    asin: ASIN,
    cpr: 'SHOULD_BE_STRIPPED',
    title: 'The Test Book',
    authorList: ['Jane Author'],
    authorsList: ['Doe, John'],
    startPosition: 0,
    endPosition: 1000,
    ...overrides
  }
  // JSONP shape the real parser expects: callback({ ...json... })
  return `metadataCallback(${JSON.stringify(obj)})`
}

function ok(body: string): FetchResult {
  return { status: 200, ok: true, body }
}

// Maps URL -> canned response (or null for a transport failure). Throws on any
// unexpected URL so tests fail loudly instead of silently mis-routing, and
// records every call so we can assert short-circuit behavior.
function mockFetcher(
  routes: Record<string, FetchResult | null>
): MetadataFetcher & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async fetchText(url: string): Promise<FetchResult | null> {
      calls.push(url)
      if (!(url in routes)) {
        throw new Error(`unexpected fetch in test: ${url}`)
      }
      return routes[url]!
    }
  }
}

describe('buildStartReadingUrl', () => {
  it('builds the startReading endpoint with asin and clientVersion', () => {
    expect(buildStartReadingUrl('ABC123')).toBe(
      'https://read.amazon.com/service/mobile/reader/startReading?asin=ABC123&clientVersion=20000100'
    )
  })
})

describe('cleanBookInfo', () => {
  it('strips transient/secret fields and preserves the rest', () => {
    const info = cleanBookInfo({
      asin: ASIN,
      karamelToken: 'SECRET',
      metadataUrl: METADATA_URL,
      YJFormatVersion: 'YJ',
      contentType: 'EBOK',
      isOwned: true
    }) as any

    expect(info.karamelToken).toBeUndefined()
    expect(info.metadataUrl).toBeUndefined()
    expect(info.YJFormatVersion).toBeUndefined()
    expect(info.contentType).toBe('EBOK')
    expect(info.isOwned).toBe(true)
  })

  it('does not mutate the input object', () => {
    const raw = { asin: ASIN, karamelToken: 'SECRET' }
    cleanBookInfo(raw)
    expect(raw.karamelToken).toBe('SECRET')
  })
})

describe('parseBookMeta', () => {
  it('parses JSONP, strips cpr, and normalizes authors', () => {
    const meta = parseBookMeta(metadataJsonp(), ASIN) as any
    expect(meta).not.toBeNull()
    expect(meta.title).toBe('The Test Book')
    expect(meta.cpr).toBeUndefined()
    // normalizeAuthors turns "Doe, John" into "John Doe"
    expect(meta.authorsList).toEqual(['John Doe'])
  })

  it('returns null when the payload is for a different ASIN', () => {
    expect(parseBookMeta(metadataJsonp({ asin: 'OTHER' }), ASIN)).toBeNull()
  })

  it('returns null for an unparseable payload', () => {
    expect(parseBookMeta('not jsonp at all', ASIN)).toBeNull()
  })
})

describe('recoverBookMetadata', () => {
  it('recovers both info and meta on the happy path', async () => {
    const fetcher = mockFetcher({
      [START_URL]: ok(startReadingBody()),
      [METADATA_URL]: ok(metadataJsonp())
    })

    const result = await recoverBookMetadata(ASIN, fetcher)

    expect(result.warnings).toEqual([])
    expect(result.info).toBeDefined()
    expect((result.info as any).karamelToken).toBeUndefined()
    expect((result.info as any).contentType).toBe('EBOK')
    expect(result.meta).toBeDefined()
    expect(result.meta!.title).toBe('The Test Book')
    expect(fetcher.calls).toEqual([START_URL, METADATA_URL])
  })

  it('short-circuits without fetching when info and meta already exist', async () => {
    const fetcher = mockFetcher({})
    const existing = {
      info: { contentType: 'EBOK' } as any,
      meta: { title: 'Already Here' } as any
    }

    const result = await recoverBookMetadata(ASIN, fetcher, existing)

    expect(fetcher.calls).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.meta!.title).toBe('Already Here')
  })

  it('warns and stops when startReading is forbidden (the live 403 case)', async () => {
    const fetcher = mockFetcher({
      [START_URL]: { status: 403, ok: false, body: 'Forbidden' }
    })

    const result = await recoverBookMetadata(ASIN, fetcher)

    expect(result.info).toBeUndefined()
    expect(result.meta).toBeUndefined()
    expect(result.warnings).toEqual(['startReading returned HTTP 403'])
    expect(fetcher.calls).toEqual([START_URL])
  })

  it('warns on a startReading transport failure', async () => {
    const fetcher = mockFetcher({ [START_URL]: null })
    const result = await recoverBookMetadata(ASIN, fetcher)
    expect(result.warnings).toEqual([
      'startReading request failed (transport error)'
    ])
  })

  it('warns when the startReading body is not valid JSON', async () => {
    const fetcher = mockFetcher({ [START_URL]: ok('<html>nope</html>') })
    const result = await recoverBookMetadata(ASIN, fetcher)
    expect(result.warnings).toEqual(['startReading body was not valid JSON'])
    expect(result.info).toBeUndefined()
  })

  it('keeps recovered info but warns when metadataUrl is missing', async () => {
    const fetcher = mockFetcher({
      [START_URL]: ok(startReadingBody({ metadataUrl: undefined }))
    })

    const result = await recoverBookMetadata(ASIN, fetcher)

    expect(result.info).toBeDefined()
    expect(result.meta).toBeUndefined()
    expect(result.warnings).toEqual([
      'startReading response had no metadataUrl'
    ])
  })

  it('keeps recovered info but warns when the metadata fetch is forbidden', async () => {
    const fetcher = mockFetcher({
      [START_URL]: ok(startReadingBody()),
      [METADATA_URL]: { status: 403, ok: false, body: '' }
    })

    const result = await recoverBookMetadata(ASIN, fetcher)

    expect(result.info).toBeDefined()
    expect(result.meta).toBeUndefined()
    expect(result.warnings).toEqual(['metadata fetch returned HTTP 403'])
  })

  it('warns when the metadata is for a different ASIN', async () => {
    const fetcher = mockFetcher({
      [START_URL]: ok(startReadingBody()),
      [METADATA_URL]: ok(metadataJsonp({ asin: 'WRONGASIN' }))
    })

    const result = await recoverBookMetadata(ASIN, fetcher)

    expect(result.meta).toBeUndefined()
    expect(result.warnings).toEqual([
      'metadata was empty or for a different ASIN'
    ])
  })

  it('fetches only the metadata leg when info is already present', async () => {
    const fetcher = mockFetcher({
      [START_URL]: ok(startReadingBody()),
      [METADATA_URL]: ok(metadataJsonp())
    })

    const result = await recoverBookMetadata(ASIN, fetcher, {
      info: { contentType: 'PREEXISTING' } as any
    })

    // startReading is still hit (it carries metadataUrl), but the pre-existing
    // info is preserved rather than overwritten.
    expect((result.info as any).contentType).toBe('PREEXISTING')
    expect(result.meta!.title).toBe('The Test Book')
    expect(result.warnings).toEqual([])
    expect(fetcher.calls).toEqual([START_URL, METADATA_URL])
  })
})
