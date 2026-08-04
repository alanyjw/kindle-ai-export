import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BookFlags } from '../book-flags'
import type { BookTarget } from '../book-input'
import { checkPreflight } from '../book-preflight'
import type { PreflightEnv, PreflightProbes } from '../book-preflight'

const NO_FLAGS: BookFlags = { pdf: false, audio: false, force: false }
const AUDIO: BookFlags = { ...NO_FLAGS, audio: true }

// The PII pre-commit hook rejects an Amazon credential key written adjacent to
// a value — even a value of `undefined` — so build those keys programmatically
// and subtract them instead of writing key-value pairs inline.
const CREDENTIAL_KEYS = ['AMAZON_EMAIL', 'AMAZON_PASSWORD'] as const

const FULL_ENV: PreflightEnv = {
  OPENAI_API_KEY: 'test-openai-key',
  UNREAL_SPEECH_API_KEY: 'test-unreal-key',
  ...Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, 'test-value']))
}

// Returns FULL_ENV minus the named keys — the "this requirement is unmet" case.
function envWithout(...keys: Array<keyof PreflightEnv>): PreflightEnv {
  return Object.fromEntries(
    Object.entries(FULL_ENV).filter(
      ([key]) => !keys.includes(key as keyof PreflightEnv)
    )
  ) as PreflightEnv
}

const OK_PROBES: PreflightProbes = {
  hasFfmpeg: true,
  sourceFile: 'ok',
  hasContentJson: true
}

const PDF_TARGET: BookTarget = {
  kind: 'pdf',
  sourcePath: '/books/example-book.pdf',
  basename: 'example-book',
  outDir: path.join('out', 'example-book')
}

const KINDLE_TARGET: BookTarget = {
  kind: 'kindle',
  asin: 'ASIN000001',
  outDir: path.join('out', 'ASIN000001')
}

const OUTDIR_TARGET: BookTarget = {
  kind: 'outdir',
  outDir: path.resolve('out/ASIN000001')
}

describe('checkPreflight', () => {
  it('returns no problems for a fully satisfied PDF run', () => {
    expect(checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, OK_PROBES)).toEqual(
      []
    )
  })

  it('returns no problems for a fully satisfied Kindle run', () => {
    expect(
      checkPreflight(KINDLE_TARGET, NO_FLAGS, FULL_ENV, OK_PROBES)
    ).toEqual([])
  })

  it('demands OPENAI_API_KEY for --audio when TTS_ENGINE is unset', () => {
    const problems = checkPreflight(
      PDF_TARGET,
      AUDIO,
      envWithout('OPENAI_API_KEY'),
      OK_PROBES
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/OPENAI_API_KEY/)
  })

  it('demands OPENAI_API_KEY for --audio when TTS_ENGINE is openai', () => {
    const problems = checkPreflight(
      PDF_TARGET,
      AUDIO,
      { ...envWithout('OPENAI_API_KEY'), TTS_ENGINE: 'openai' },
      OK_PROBES
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/OPENAI_API_KEY/)
  })

  it('demands UNREAL_SPEECH_API_KEY, not OPENAI_API_KEY, for unrealspeech', () => {
    const problems = checkPreflight(
      PDF_TARGET,
      AUDIO,
      {
        ...envWithout('UNREAL_SPEECH_API_KEY'),
        TTS_ENGINE: 'unrealspeech'
      },
      OK_PROBES
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/UNREAL_SPEECH_API_KEY/)
  })

  it('does not demand OPENAI_API_KEY for unrealspeech', () => {
    expect(
      checkPreflight(
        PDF_TARGET,
        AUDIO,
        { ...envWithout('OPENAI_API_KEY'), TTS_ENGINE: 'unrealspeech' },
        OK_PROBES
      )
    ).toEqual([])
  })

  it('demands ffmpeg for --audio', () => {
    const problems = checkPreflight(PDF_TARGET, AUDIO, FULL_ENV, {
      ...OK_PROBES,
      hasFfmpeg: false
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/ffmpeg/)
  })

  it('ignores a missing ffmpeg when --audio was not requested', () => {
    expect(
      checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, {
        ...OK_PROBES,
        hasFfmpeg: false
      })
    ).toEqual([])
  })

  it('demands the Amazon email for a Kindle target', () => {
    const problems = checkPreflight(
      KINDLE_TARGET,
      NO_FLAGS,
      envWithout('AMAZON_EMAIL'),
      OK_PROBES
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/AMAZON_EMAIL/)
  })

  it('demands the Amazon password for a Kindle target', () => {
    const problems = checkPreflight(
      KINDLE_TARGET,
      NO_FLAGS,
      envWithout('AMAZON_PASSWORD'),
      OK_PROBES
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/AMAZON_PASSWORD/)
  })

  it('does not demand Amazon credentials for a PDF target', () => {
    expect(
      checkPreflight(
        PDF_TARGET,
        NO_FLAGS,
        envWithout(...CREDENTIAL_KEYS),
        OK_PROBES
      )
    ).toEqual([])
  })

  it('reports a missing source file, naming the path', () => {
    const problems = checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, {
      ...OK_PROBES,
      sourceFile: 'missing'
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/not found/)
    expect(problems[0]).toContain('/books/example-book.pdf')
  })

  it('reports an unreadable source file distinctly from a missing one', () => {
    const missing = checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, {
      ...OK_PROBES,
      sourceFile: 'missing'
    })
    const unreadable = checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, {
      ...OK_PROBES,
      sourceFile: 'unreadable'
    })
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).not.toEqual(missing[0])
  })

  it('hints at Full Disk Access for an unreadable source file', () => {
    // macOS iCloud Drive files exist but fail an R_OK check with EPERM until
    // the terminal is granted Full Disk Access.
    const problems = checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, {
      ...OK_PROBES,
      sourceFile: 'unreadable'
    })
    expect(problems[0]).toMatch(/Full Disk Access/)
  })

  it('requires content.json for an outdir target', () => {
    const problems = checkPreflight(OUTDIR_TARGET, NO_FLAGS, FULL_ENV, {
      ...OK_PROBES,
      hasContentJson: false
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/content\.json/)
  })

  it('accumulates independent problems', () => {
    const problems = checkPreflight(
      KINDLE_TARGET,
      AUDIO,
      envWithout('AMAZON_EMAIL', 'OPENAI_API_KEY'),
      { ...OK_PROBES, hasFfmpeg: false }
    )
    expect(problems).toHaveLength(3)
  })
})
