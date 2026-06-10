import { describe, expect, it } from 'vitest'

import { resolveBookMeta } from '../book-meta'
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
      metaWith({ title: 'On Writing Well', authorList: ['William Zinsser'] }),
      'out/B0090RVGW0-On Writing Well'
    )
    expect(result.synthesized).toBe(false)
    expect(result.title).toBe('On Writing Well')
    expect(result.authorList).toEqual(['William Zinsser'])
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
      'out/B0090RVGW0-On Writing Well'
    )
    expect(result.synthesized).toBe(true)
    expect(result.title).toBe('On Writing Well')
    expect(result.authorList).toEqual([])
    expect(result.warning).toContain('meta.title) is missing')
    // The warning should point at the recovery tool with the dir basename.
    expect(result.warning).toContain('src/set-book-meta.ts')
    expect(result.warning).toContain('B0090RVGW0-On Writing Well')
  })

  it('falls back to the bare dir name when there is no title suffix', () => {
    const result = resolveBookMeta(
      { meta: undefined as unknown as BookMetadata['meta'] },
      'out/B0090RVGW0'
    )
    expect(result.synthesized).toBe(true)
    expect(result.title).toBe('B0090RVGW0')
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
