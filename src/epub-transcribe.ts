import fs from 'node:fs/promises'
import path from 'node:path'

import { parse } from 'node-html-parser'

import type {
  BookInfo,
  BookMeta,
  BookMetadata,
  ContentChunk,
  PageChunk,
  TocItem
} from './types'
import {
  closeEpub,
  getEpubChapterHtml,
  getEpubImage,
  getEpubMetadata,
  getEpubNav,
  getEpubSpine,
  openEpub,
  resolveZipHref
} from './epub'
import { sectionHtmlToMarkdown } from './epub-markdown'
import { deriveSections, type Section } from './epub-sections'

const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff'
}

function extFor(mediaType: string, resolvedHref: string): string {
  return MEDIA_TYPE_EXT[mediaType.toLowerCase()] ?? path.extname(resolvedHref)
}

function stripExt(name: string): string {
  const ext = path.extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

function sanitizeFileName(name: string): string {
  return name
    .replaceAll(/["*/:<>?\\|]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

// Extracts a section's images to <outDir>/images and returns a src→ref map for
// the converter. Memoizes by resolved zip href so one source image is written
// once even when referenced from multiple sections.
async function extractSectionImages(
  epubPath: string,
  section: Section,
  imagesDir: string,
  memo: Map<string, string>,
  usedNames: Set<string>
): Promise<Map<string, string>> {
  const srcMap = new Map<string, string>()
  const root = parse(section.html)

  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src || src.startsWith('data:')) continue

    const resolved = resolveZipHref(section.spineHref, src)
    if (!resolved) continue // unresolvable / zip-slip → drop (left out of srcMap)

    const memoized = memo.get(resolved)
    if (memoized) {
      srcMap.set(src, memoized)
      continue
    }

    const image = await getEpubImage(epubPath, resolved)
    if (!image) continue // missing/non-image → drop

    const ext = extFor(image.mediaType, resolved)
    const base = sanitizeFileName(stripExt(path.basename(resolved))) || 'image'
    let name = `${base}${ext}`
    let n = 2
    while (usedNames.has(name)) name = `${base}-${n++}${ext}`
    usedNames.add(name)

    const target = path.join(imagesDir, name)
    // Containment guard: name is sanitized (no separators), but assert anyway.
    if (!path.resolve(target).startsWith(path.resolve(imagesDir) + path.sep)) {
      continue
    }
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(target, image.data)

    const ref = `images/${name}`
    memo.set(resolved, ref)
    srcMap.set(src, ref)
  }

  return srcMap
}

function defaultBookInfo(): BookInfo {
  return {
    clippingLimit: 0,
    contentChecksum: null,
    contentType: 'EBOK',
    contentVersion: '',
    deliveredAsin: '',
    downloadRestrictionReason: null,
    expirationDate: null,
    format: 'epub',
    formatVersion: '',
    fragmentMapUrl: null,
    hasAnnotations: false,
    isOwned: true,
    isSample: false,
    kindleSessionId: '',
    lastPageReadData: { deviceName: '', position: 0, syncTime: 0 },
    manifestUrl: null,
    originType: '',
    pageNumberUrl: null,
    requestedAsin: '',
    srl: 0
  }
}

export interface EpubArtifacts {
  content: ContentChunk[]
  metadata: BookMetadata
}

// Transcribes an EPUB into content.json + metadata.json shapes. Writes extracted
// images to <outDir>/images; the caller persists content/metadata.
export async function extractEpub(
  epubPath: string,
  outDir: string,
  blankMarker = '[BLANK_PAGE]'
): Promise<EpubArtifacts> {
  await openEpub(epubPath)
  try {
    const [spine, nav, meta] = await Promise.all([
      getEpubSpine(epubPath),
      getEpubNav(epubPath),
      getEpubMetadata(epubPath)
    ])

    const sections = await deriveSections(
      spine,
      nav,
      (id) => getEpubChapterHtml(epubPath, id),
      meta.title
    )

    const imagesDir = path.join(outDir, 'images')
    const imageMemo = new Map<string, string>()
    const usedNames = new Set<string>()

    const content: ContentChunk[] = []
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!
      const srcMap = await extractSectionImages(
        epubPath,
        section,
        imagesDir,
        imageMemo,
        usedNames
      )
      const md = sectionHtmlToMarkdown(section.html, {
        stripLeadingHeading: section.stripLeadingHeading,
        resolveImage: (src) => srcMap.get(src) ?? null
      })
      content.push({
        index: i,
        page: i + 1,
        text: md || blankMarker,
        screenshot: `epub:${section.key}`
      })
    }

    const total = sections.length
    const meta_: BookMeta = {
      ACR: '',
      asin: '',
      authorList: meta.authors,
      bookSize: '',
      bookType: '',
      cover: '',
      language: meta.language ?? '',
      positions: { cover: 0, srl: 0, toc: 0 },
      publisher: meta.publisher ?? '',
      refEmId: '',
      releaseDate: '',
      sample: false,
      title: meta.title,
      version: '',
      startPosition: 0,
      endPosition: total
    }

    const toc: TocItem[] = [
      ...sections.map((s, i) => ({ title: s.title, page: i + 1, total })),
      { title: '', total } // trailing sentinel (page omitted → renders last section)
    ]

    const pages: PageChunk[] = sections.map((s, i) => ({
      index: i,
      page: i + 1,
      total,
      screenshot: `epub:${s.key}`
    }))

    const metadata: BookMetadata = {
      info: defaultBookInfo(),
      meta: meta_,
      toc,
      pages
    }
    return { content, metadata }
  } finally {
    await closeEpub(epubPath)
  }
}
