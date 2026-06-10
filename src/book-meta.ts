import path from 'node:path'

import type { BookMetadata } from './types'

export interface ResolvedBookMeta {
  title: string
  authorList: string[]
  // True when the title was derived from a fallback because `meta` was missing.
  synthesized: boolean
  // Present only when synthesized — a human-readable note for the caller to log.
  warning?: string
}

// Derive the display title/author for an export.
//
// Prefers the captured `meta`, but degrades gracefully when metadata capture
// failed (e.g. Amazon 403s the reader metadata API) so a fully-transcribed book
// still exports instead of hard-failing on two missing strings. The out-dir
// convention is `<ASIN>-<Title>`, so the suffix after the first '-' is a decent
// human title when present; otherwise we fall back to the bare directory name.
export function resolveBookMeta(
  metadata: Pick<BookMetadata, 'meta'>,
  outDir: string
): ResolvedBookMeta {
  const meta = metadata.meta as BookMetadata['meta'] | undefined
  const title = typeof meta?.title === 'string' ? meta.title.trim() : ''
  const authorList = Array.isArray(meta?.authorList) ? meta!.authorList : []

  if (title) {
    return { title, authorList, synthesized: false }
  }

  const base = path.basename(outDir)
  const dashIndex = base.indexOf('-')
  const fallbackTitle =
    dashIndex >= 0 && dashIndex < base.length - 1
      ? base.slice(dashIndex + 1)
      : base

  return {
    title: fallbackTitle,
    authorList,
    synthesized: true,
    warning:
      `⚠️  Book metadata (meta.title) is missing — using "${fallbackTitle}" as the title. ` +
      `To set the real title/author, run: ` +
      `pnpm tsx src/set-book-meta.ts ${base} "<title>" "<author[,author2]>"`
  }
}
