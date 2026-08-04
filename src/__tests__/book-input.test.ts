import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyBookArg, resolveBookTarget } from '../book-input'

// classifyBookArg takes its directory probe as a parameter so these tests never
// touch the filesystem.
const noDirs = () => false
const allDirs = () => true

describe('classifyBookArg', () => {
  it('classifies a .pdf path', () => {
    expect(classifyBookArg('/books/example-book.pdf', noDirs)).toEqual({
      kind: 'pdf',
      sourcePath: path.resolve('/books/example-book.pdf'),
      basename: 'example-book'
    })
  })

  it('classifies a .epub path', () => {
    expect(classifyBookArg('/books/example-book.epub', noDirs)).toEqual({
      kind: 'epub',
      sourcePath: path.resolve('/books/example-book.epub'),
      basename: 'example-book'
    })
  })

  it('matches the extension case-insensitively', () => {
    expect(classifyBookArg('/books/Example.PDF', noDirs).kind).toBe('pdf')
    expect(classifyBookArg('/books/Example.EPUB', noDirs).kind).toBe('epub')
  })

  it('sanitizes the basename into a directory-safe form', () => {
    const result = classifyBookArg('/books/Example: A Book?.pdf', noDirs)
    expect(result).toMatchObject({ kind: 'pdf', basename: 'Example A Book' })
  })

  it('preserves spaces in the basename', () => {
    expect(classifyBookArg('/books/Example Book.pdf', noDirs)).toMatchObject({
      basename: 'Example Book'
    })
  })

  it('classifies an out/ path as outdir on its separator alone', () => {
    expect(classifyBookArg('out/ASIN000001', noDirs)).toEqual({
      kind: 'outdir',
      outDir: path.resolve('out/ASIN000001')
    })
  })

  it('classifies a bare name that is an existing directory as outdir', () => {
    expect(classifyBookArg('ASIN000001', allDirs)).toEqual({
      kind: 'outdir',
      outDir: path.resolve('ASIN000001')
    })
  })

  it('classifies a bare name that is not a directory as a Kindle ASIN', () => {
    expect(classifyBookArg('ASIN000001', noDirs)).toEqual({
      kind: 'kindle',
      asin: 'ASIN000001'
    })
  })

  it('trims surrounding whitespace before classifying', () => {
    expect(classifyBookArg('  ASIN000001  ', noDirs)).toEqual({
      kind: 'kindle',
      asin: 'ASIN000001'
    })
  })

  it('throws on undefined', () => {
    expect(() => classifyBookArg(undefined, noDirs)).toThrow(
      /input is required/
    )
  })

  it('throws on an empty or whitespace-only string', () => {
    expect(() => classifyBookArg('', noDirs)).toThrow(/input is required/)
    expect(() => classifyBookArg('   ', noDirs)).toThrow(/input is required/)
  })

  it('includes usage text in the missing-input error', () => {
    expect(() => classifyBookArg(undefined, noDirs)).toThrow(
      /pnpm book <input>/
    )
  })
})

describe('resolveBookTarget', () => {
  it('derives a relative out/ directory for a PDF', async () => {
    await expect(
      resolveBookTarget('/books/Example Book.pdf', noDirs)
    ).resolves.toEqual({
      kind: 'pdf',
      sourcePath: path.resolve('/books/Example Book.pdf'),
      basename: 'Example Book',
      outDir: path.join('out', 'Example Book')
    })
  })

  it('derives the same shape for an EPUB', async () => {
    await expect(
      resolveBookTarget('/books/Example Book.epub', noDirs)
    ).resolves.toMatchObject({
      kind: 'epub',
      outDir: path.join('out', 'Example Book')
    })
  })

  it('passes an outdir target through unchanged', async () => {
    await expect(resolveBookTarget('out/ASIN000001', noDirs)).resolves.toEqual({
      kind: 'outdir',
      outDir: path.resolve('out/ASIN000001')
    })
  })

  it('resolves a Kindle ASIN through resolveOutDir', async () => {
    // No out/ASIN000001* directory exists in the repo, so resolveOutDir falls
    // back to the bare out/<asin> form.
    await expect(resolveBookTarget('ASIN000001', noDirs)).resolves.toEqual({
      kind: 'kindle',
      asin: 'ASIN000001',
      outDir: path.join('out', 'ASIN000001')
    })
  })
})
