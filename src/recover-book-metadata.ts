import type { BookInfo, BookMeta } from './types'
import { normalizeAuthors, parseJsonpResponse } from './utils'

// Result of a single GET against the authenticated reader context. `null`
// represents a transport-level failure (network error, CORS block) as opposed
// to an HTTP error response, which is reported via `ok`/`status`.
export interface FetchResult {
  status: number
  ok: boolean
  body: string
}

// A minimal fetch abstraction so the recovery orchestration is testable without
// a real browser. Implementations run the request inside the authenticated
// Kindle reader context (see extract-kindle-book.ts).
export interface MetadataFetcher {
  fetchText(url: string): Promise<FetchResult | null>
}

export interface RecoverMetadataResult {
  info?: BookInfo
  meta?: BookMeta
  // Human-readable diagnostics for the caller to log. Empty on full success.
  warnings: string[]
}

const CLIENT_VERSION = '20000100'

// Endpoint shape mirrors kindle-api-ky's getBookDetails. ASINs are alphanumeric
// so no escaping is needed (and the rest of the codebase interpolates them
// directly too).
export function buildStartReadingUrl(
  asin: string,
  clientVersion: string = CLIENT_VERSION
): string {
  return `https://read.amazon.com/service/mobile/reader/startReading?asin=${asin}&clientVersion=${clientVersion}`
}

// Strip the transient/secret fields the passive listener also drops, matching
// the shape written to metadata.json.
export function cleanBookInfo(raw: Record<string, any>): BookInfo {
  const cleaned = { ...raw }
  delete cleaned.karamelToken
  delete cleaned.metadataUrl
  delete cleaned.YJFormatVersion
  return cleaned as unknown as BookInfo
}

// Parse the YJmetadata JSONP payload into a BookMeta, applying the same
// normalization the passive listener does. Returns null when the payload is
// empty or belongs to a different ASIN.
export function parseBookMeta(jsonp: string, asin: string): BookMeta | null {
  const metadata = parseJsonpResponse<any>(jsonp)
  if (!metadata || metadata.asin !== asin) return null
  delete metadata.cpr
  if (Array.isArray(metadata.authorsList)) {
    metadata.authorsList = normalizeAuthors(metadata.authorsList)
  }
  return metadata as BookMeta
}

// Recover book `info`/`meta` by actively replaying startReading + the
// metadataUrl it returns. Pure orchestration over an injected fetcher: no
// Playwright, no I/O, no console. The caller logs the returned warnings.
//
// Short-circuits when both `info` and `meta` are already present. Each failure
// mode produces a specific warning and stops only the step that failed (e.g. a
// metadata 403 still returns the recovered `info`).
export async function recoverBookMetadata(
  asin: string,
  fetcher: MetadataFetcher,
  existing: { info?: BookInfo; meta?: BookMeta } = {}
): Promise<RecoverMetadataResult> {
  const warnings: string[] = []
  let info = existing.info
  let meta = existing.meta

  if (info != null && meta != null) {
    return { info, meta, warnings }
  }

  const startRes = await fetcher.fetchText(buildStartReadingUrl(asin))
  if (!startRes) {
    warnings.push('startReading request failed (transport error)')
    return { info, meta, warnings }
  }
  if (!startRes.ok) {
    warnings.push(`startReading returned HTTP ${startRes.status}`)
    return { info, meta, warnings }
  }

  let startBody: Record<string, any>
  try {
    startBody = JSON.parse(startRes.body) as Record<string, any>
  } catch {
    warnings.push('startReading body was not valid JSON')
    return { info, meta, warnings }
  }

  const metadataUrl: string | undefined = startBody.metadataUrl
  if (info == null) {
    info = cleanBookInfo(startBody)
  }

  if (meta == null) {
    if (!metadataUrl) {
      warnings.push('startReading response had no metadataUrl')
      return { info, meta, warnings }
    }
    const metaRes = await fetcher.fetchText(metadataUrl)
    if (!metaRes) {
      warnings.push('metadata request failed (transport error)')
      return { info, meta, warnings }
    }
    if (!metaRes.ok) {
      warnings.push(`metadata fetch returned HTTP ${metaRes.status}`)
      return { info, meta, warnings }
    }
    const parsed = parseBookMeta(metaRes.body, asin)
    if (!parsed) {
      warnings.push('metadata was empty or for a different ASIN')
      return { info, meta, warnings }
    }
    meta = parsed
  }

  return { info, meta, warnings }
}
