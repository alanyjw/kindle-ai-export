import { describe, expect, it } from 'vitest'

import { hasExportableBookMeta, resolveBookMeta } from '../book-meta'
import type { BookMetadata } from '../types'

// Minimal meta with just the fields the exporters (and resolveBookMeta) read.
function metaWith(
  fields: Partial<BookMetadata['meta']>
): Pick<BookMetadata, 'meta'> {
  return { meta: fields as BookMetadata['meta'] }
}

describe('resolveBookMeta', () => {
  it('uses the captured title and authors when present', () => {
    const result = resolveBookMeta(
      metaWith({ title: 'Example Book', authorList: ['Author Name'] }),
      'out/ASIN000001-Example Book'
    )
    expect(result.synthesized).toBe(false)
    expect(result.title).toBe('Example Book')
    expect(result.authorList).toEqual(['Author Name'])
    expect(result.warning).toBeUndefined()
  })

  it('trims a padded captured title', () => {
    const result = resolveBookMeta(
      metaWith({ title: '  Spacey Title  ', authorList: [] }),
      'out/X'
    )
    expect(result.title).toBe('Spacey Title')
    expect(result.synthesized).toBe(false)
  })

  it('falls back to the out-dir title suffix when meta is missing', () => {
    const result = resolveBookMeta(
      { meta: undefined as unknown as BookMetadata['meta'] },
      'out/ASIN000001-Example Book'
    )
    expect(result.synthesized).toBe(true)
    expect(result.title).toBe('Example Book')
    expect(result.authorList).toEqual([])
    expect(result.warning).toContain('meta.title) is missing')
    // The warning should point at the recovery tool with the dir basename.
    expect(result.warning).toContain('src/set-book-meta.ts')
    expect(result.warning).toContain('ASIN000001-Example Book')
  })

  it('falls back to the bare dir name when there is no title suffix', () => {
    const result = resolveBookMeta(
      { meta: undefined as unknown as BookMetadata['meta'] },
      'out/ASIN000001'
    )
    expect(result.synthesized).toBe(true)
    expect(result.title).toBe('ASIN000001')
  })

  it('treats an empty/whitespace title as missing and synthesizes', () => {
    const result = resolveBookMeta(
      metaWith({ title: '   ', authorList: ['Someone'] }),
      'out/ABC-Real Title'
    )
    expect(result.synthesized).toBe(true)
    expect(result.title).toBe('Real Title')
    // Authors that WERE captured are still carried through.
    expect(result.authorList).toEqual(['Someone'])
  })

  it('handles a trailing-dash dir name without producing an empty title', () => {
    const result = resolveBookMeta(
      { meta: undefined as unknown as BookMetadata['meta'] },
      'out/ABC-'
    )
    expect(result.title).toBe('ABC-')
  })
})

describe('hasExportableBookMeta', () => {
  it('accepts a book whose title was captured', () => {
    expect(
      hasExportableBookMeta(metaWith({ title: 'Example Book', authorList: [] }))
    ).toBe(true)
  })

  // `info` (Kindle sync positions) has no downstream consumer: no exporter
  // reads it, and Amazon now 403s the API that supplies it. Gating on it made
  // every subsequent run relaunch a browser to chase something unrecoverable.
  it('accepts a book that has meta but never captured info', () => {
    const metadata: Partial<BookMetadata> = {
      ...metaWith({ title: 'Example Book', authorList: [] }),
      info: undefined
    }
    expect(hasExportableBookMeta(metadata)).toBe(true)
  })

  it('rejects a book with no meta at all', () => {
    expect(hasExportableBookMeta({ meta: undefined })).toBe(false)
  })

  it('rejects meta that carries no title', () => {
    expect(hasExportableBookMeta(metaWith({ authorList: [] }))).toBe(false)
  })

  // Must agree with resolveBookMeta, which trims before deciding a title is
  // missing. If these two ever disagree, extraction would call a book complete
  // that the exporters then treat as untitled.
  it('rejects a whitespace-only title, matching resolveBookMeta', () => {
    const metadata = metaWith({ title: '   ', authorList: [] })
    expect(hasExportableBookMeta(metadata)).toBe(false)
    expect(resolveBookMeta(metadata, 'out/X').synthesized).toBe(true)
  })

  it('rejects a non-string title', () => {
    expect(hasExportableBookMeta(metaWith({ title: 42 as any }))).toBe(false)
  })
})
