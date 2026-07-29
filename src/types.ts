export interface ContentChunk {
  index: number
  page: number
  text: string
  screenshot: string
}

export interface TocItem {
  title: string
  page?: number
  location?: number
  total: number
  // Nesting depth in the source's table of contents (0 = top level). Only the
  // PDF outline currently reports it; absent means "top level".
  level?: number
}

export interface PageChunk {
  index: number
  page: number
  total: number
  screenshot: string
}

export interface BookMeta {
  ACR: string
  asin: string
  authorList: Array<string>
  bookSize: string
  bookType: string
  cover: string
  language: string
  positions: {
    cover: number
    srl: number
    toc: number
  }
  publisher: string
  refEmId: string
  releaseDate: string
  sample: boolean
  title: string
  version: string
  startPosition: number
  endPosition: number
}

export interface BookInfo {
  clippingLimit: number
  contentChecksum: any
  contentType: string
  contentVersion: string
  deliveredAsin: string
  downloadRestrictionReason: any
  expirationDate: any
  format: string
  formatVersion: string
  fragmentMapUrl: any
  hasAnnotations: boolean
  isOwned: boolean
  isSample: boolean
  kindleSessionId: string
  lastPageReadData: {
    deviceName: string
    position: number
    syncTime: number
  }
  manifestUrl: any
  originType: string
  pageNumberUrl: any
  requestedAsin: string
  srl: number
}

export interface FrontMatterShot {
  title: string
  screenshot: string
}

export interface BookMetadata {
  // `info`/`meta` come from Amazon's reader APIs and can legitimately be
  // absent: the PDF pipeline has no such APIs at all, and the Kindle one can
  // be 403'd. Exporters degrade via `resolveBookMeta()` rather than failing.
  info?: BookInfo
  meta?: BookMeta
  // Which pipeline produced this metadata. Absent means Kindle, the original
  // (and still default) source.
  source?: 'pdf' | 'epub'
  toc: TocItem[]
  pages: PageChunk[]
  // Front-matter page screenshots (Title Page, Cover, …) captured for metadata
  // recovery when the Amazon metadata API is unavailable. Optional: only the
  // Kindle extractor produces these, and only on a best-effort basis.
  frontMatter?: FrontMatterShot[]
}
