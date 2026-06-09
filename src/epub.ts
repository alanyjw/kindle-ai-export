import { EPub } from 'epub2'
import { parse } from 'node-html-parser'

// Thin, typed wrapper around epub2. This is the ONLY module that imports epub2,
// mirroring how pdf.ts is the only importer of pdfjs-dist. epub2 exposes a
// Bluebird-based async API; we always `await` and adapt its tuple returns.

export interface EpubSpineItem {
  id: string // OPF idref
  href: string // zip-root-relative path; base dir for resolving relative hrefs
  index: number // 0-based spine position
}

export interface EpubNavEntry {
  title: string
  fileHref: string // target spine file (fragment stripped, zip-root-relative)
  fragment?: string // element id within the file, if present
  order: number // position in the flattened nav walk
}

export interface EpubMetadata {
  title: string
  authors: string[]
  language?: string
  publisher?: string
}

const epubCache = new Map<string, Promise<EPub>>()

async function load(epubPath: string): Promise<EPub> {
  let cached = epubCache.get(epubPath)
  if (!cached) {
    cached = EPub.createAsync(epubPath) as unknown as Promise<EPub>
    epubCache.set(epubPath, cached)
  }
  return cached
}

export async function openEpub(epubPath: string): Promise<void> {
  await load(epubPath)
}

export async function closeEpub(epubPath: string): Promise<void> {
  // epub2 holds no external handles after parse; just drop the cache entry.
  epubCache.delete(epubPath)
}

export async function getEpubMetadata(epubPath: string): Promise<EpubMetadata> {
  const ep = await load(epubPath)
  const meta = (ep as any).metadata ?? {}
  // epub2 collapses multiple <dc:creator> into a single string.
  const creator = typeof meta.creator === 'string' ? meta.creator.trim() : ''
  return {
    title: typeof meta.title === 'string' ? meta.title : '',
    authors: creator ? [creator] : [],
    language: typeof meta.language === 'string' ? meta.language : undefined,
    publisher: typeof meta.publisher === 'string' ? meta.publisher : undefined
  }
}

export async function getEpubSpine(epubPath: string): Promise<EpubSpineItem[]> {
  const ep = await load(epubPath)
  const contents: any[] = (ep as any).spine?.contents ?? (ep as any).flow ?? []
  return contents
    .filter(
      (it) => it && typeof it.id === 'string' && typeof it.href === 'string'
    )
    .map((it, index) => ({ id: it.id, href: stripFragment(it.href), index }))
}

// Splits "path#frag" → { path, fragment }.
function splitHref(href: string): { path: string; fragment?: string } {
  const i = href.indexOf('#')
  if (i === -1) return { path: href }
  return { path: href.slice(0, i), fragment: href.slice(i + 1) || undefined }
}

function stripFragment(href: string): string {
  return splitHref(href).path
}

// Resolves a possibly-relative href against a base file's directory and
// normalizes to a zip-root-relative path. Returns null if it escapes the root
// (zip-slip guard) or has an absolute/remote form we don't handle.
export function resolveZipHref(
  baseFileHref: string,
  rel: string
): string | null {
  if (!rel) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return null // has a scheme (http:, data:, …)
  const baseDir = baseFileHref.includes('/')
    ? baseFileHref.slice(0, baseFileHref.lastIndexOf('/'))
    : ''
  const startsAtRoot = rel.startsWith('/')
  const combined = startsAtRoot
    ? rel.slice(1)
    : baseDir
      ? `${baseDir}/${rel}`
      : rel
  const parts: string[] = []
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null // escapes the zip root
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.length ? parts.join('/') : null
}

export async function getEpubChapterHtml(
  epubPath: string,
  id: string
): Promise<string> {
  const ep = await load(epubPath)
  // Raw (not getChapterAsync): preserves original <img src> and <head> so we
  // can resolve images and split on fragment ids ourselves.
  return (ep as any).getChapterRawAsync(id)
}

export async function getEpubImage(
  epubPath: string,
  resolvedHref: string
): Promise<{ data: Buffer; mediaType: string } | null> {
  const ep = await load(epubPath)
  const id = manifestIdForHref(ep, resolvedHref)
  if (!id) return null
  try {
    const [data, mediaType] = (await (ep as any).getImageAsync(id)) as [
      Buffer,
      string
    ]
    if (!data || typeof mediaType !== 'string') return null
    return { data, mediaType }
  } catch {
    // getImageAsync rejects on missing/non-image; treat as "no image".
    return null
  }
}

// Returns the manifest id whose href matches the given zip-root-relative path,
// tolerating coordinate-system differences via a basename fallback.
function manifestIdForHref(ep: EPub, resolvedHref: string): string | null {
  const manifest = (ep as any).manifest ?? {}
  const target = resolvedHref
  const targetBase = basename(target)
  let basenameMatch: string | null = null
  for (const [id, item] of Object.entries<any>(manifest)) {
    const href = typeof item?.href === 'string' ? item.href : ''
    if (!href) continue
    if (href === target) return id
    if (basename(href) === targetBase) basenameMatch = id
  }
  return basenameMatch
}

function basename(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
}

export async function getEpubNav(epubPath: string): Promise<EpubNavEntry[]> {
  const ep = await load(epubPath)

  // 1. NCX (epub2 populates `toc` only when the OPF spine has a `toc=` attr).
  const ncx: any[] = (ep as any).toc ?? []
  if (ncx.length > 0) {
    return ncx
      .filter((e) => e && typeof e.href === 'string')
      .map((e, order) => {
        const { path, fragment } = splitHref(e.href)
        return {
          title: typeof e.title === 'string' ? e.title.trim() : '',
          fileHref: path,
          fragment,
          order
        }
      })
  }

  // 2. EPUB3 nav.xhtml — epub2 does NOT parse it; locate via manifest
  //    properties="nav" and parse it ourselves.
  const manifest = (ep as any).manifest ?? {}
  const navEntry = Object.entries<any>(manifest).find(([, item]) =>
    String(item?.properties ?? '')
      .split(/\s+/)
      .includes('nav')
  )
  if (!navEntry) return []

  const [navId, navItem] = navEntry
  const navHref: string = navItem.href
  let html: string
  try {
    const [buf] = (await (ep as any).getFileAsync(navId)) as [Buffer, string]
    html = buf.toString('utf8')
  } catch {
    return []
  }

  const root = parse(html)
  const nav =
    root.querySelector('nav[epub\\:type="toc"]') ?? root.querySelector('nav')
  if (!nav) return []

  const entries: EpubNavEntry[] = []
  for (const a of nav.querySelectorAll('a')) {
    const rawHref = a.getAttribute('href')
    if (!rawHref) continue
    const { path, fragment } = splitHref(rawHref)
    const resolved = resolveZipHref(navHref, path)
    if (!resolved) continue
    entries.push({
      title: a.text.trim(),
      fileHref: resolved,
      fragment,
      order: entries.length
    })
  }
  return entries
}
