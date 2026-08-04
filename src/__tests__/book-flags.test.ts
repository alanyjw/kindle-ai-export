import { describe, expect, it } from 'vitest'

import { parseBookFlags } from '../book-flags'

describe('parseBookFlags', () => {
  it('defaults every flag to false', () => {
    expect(parseBookFlags([])).toEqual({
      pdf: false,
      audio: false,
      force: false
    })
  })

  it('sets pdf for --pdf', () => {
    expect(parseBookFlags(['--pdf'])).toEqual({
      pdf: true,
      audio: false,
      force: false
    })
  })

  it('sets audio for --audio', () => {
    expect(parseBookFlags(['--audio'])).toEqual({
      pdf: false,
      audio: true,
      force: false
    })
  })

  it('sets force for --force', () => {
    expect(parseBookFlags(['--force'])).toEqual({
      pdf: false,
      audio: false,
      force: true
    })
  })

  it('treats --all as --pdf --audio', () => {
    expect(parseBookFlags(['--all'])).toEqual(
      parseBookFlags(['--pdf', '--audio'])
    )
  })

  it('does not let --all imply --force', () => {
    expect(parseBookFlags(['--all']).force).toBe(false)
  })

  it('is order independent', () => {
    expect(parseBookFlags(['--audio', '--pdf'])).toEqual(
      parseBookFlags(['--pdf', '--audio'])
    )
  })

  it('is idempotent for a repeated flag', () => {
    expect(parseBookFlags(['--pdf', '--pdf'])).toEqual(
      parseBookFlags(['--pdf'])
    )
  })

  it('throws on an unknown flag, naming it', () => {
    expect(() => parseBookFlags(['--pfd'])).toThrow(/--pfd/)
  })

  it('throws on a bare positional argument', () => {
    // The input is consumed by the caller before flags are parsed, so anything
    // reaching parseBookFlags is meant to be a flag.
    expect(() => parseBookFlags(['book.pdf'])).toThrow(/book\.pdf/)
  })

  it('does not mutate the argv it is given', () => {
    const argv = ['--pdf', '--audio']
    parseBookFlags(argv)
    expect(argv).toEqual(['--pdf', '--audio'])
  })
})
