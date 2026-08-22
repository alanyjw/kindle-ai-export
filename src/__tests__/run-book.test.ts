import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BookFlags } from '../book-flags'
import type { BookTarget } from '../book-input'
import { BookStepError, runBook } from '../book'
import type { BookSteps } from '../book'

const NO_FLAGS: BookFlags = { pdf: false, audio: false, force: false }

const PDF_TARGET: BookTarget = {
  kind: 'pdf',
  sourcePath: '/books/example-book.pdf',
  basename: 'example-book',
  outDir: path.join('out', 'example-book')
}

const EPUB_TARGET: BookTarget = {
  kind: 'epub',
  sourcePath: '/books/example-book.epub',
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

interface Recorded {
  calls: string[]
  args: Record<string, unknown>
}

// Builds a BookSteps whose every member records that it ran. `overrides` lets
// a test swap in a throwing or renaming implementation.
function recordingSteps(
  recorded: Recorded,
  overrides: Partial<BookSteps> = {}
): BookSteps {
  const record =
    (name: string, result: unknown) =>
    async (...callArgs: unknown[]) => {
      recorded.calls.push(name)
      recorded.args[name] = callArgs
      return result
    }

  return {
    extractKindleBook: record('extract', {
      outDir: KINDLE_TARGET.outDir
    }) as BookSteps['extractKindleBook'],
    transcribeBookContent: record(
      'transcribe',
      undefined
    ) as BookSteps['transcribeBookContent'],
    exportBookMarkdown: record(
      'markdown',
      undefined
    ) as BookSteps['exportBookMarkdown'],
    exportBookPdf: record('pdf', undefined) as BookSteps['exportBookPdf'],
    exportBookAudio: record('audio', undefined) as BookSteps['exportBookAudio'],
    // A no-op rename must echo back the directory it was handed, exactly as
    // the real one does when there is nothing to rename — returning a fixed
    // path would mask the out-dir extraction already renamed.
    renameBookDir: (async (opts: { outDir: string }) => {
      recorded.calls.push('rename')
      recorded.args.rename = [opts]
      return { renamed: false, outDir: opts.outDir }
    }) as BookSteps['renameBookDir'],
    ...overrides
  }
}

function newRecorded(): Recorded {
  return { calls: [], args: {} }
}

describe('runBook', () => {
  it('runs extract before transcribe for a Kindle target', async () => {
    const recorded = newRecorded()
    await runBook(KINDLE_TARGET, NO_FLAGS, recordingSteps(recorded))
    expect(recorded.calls).toEqual([
      'extract',
      'transcribe',
      'markdown',
      'rename'
    ])
  })

  it('skips extract for a PDF target', async () => {
    const recorded = newRecorded()
    await runBook(PDF_TARGET, NO_FLAGS, recordingSteps(recorded))
    expect(recorded.calls).toEqual(['transcribe', 'markdown'])
  })

  it('skips extract for an EPUB target', async () => {
    const recorded = newRecorded()
    await runBook(EPUB_TARGET, NO_FLAGS, recordingSteps(recorded))
    expect(recorded.calls).toEqual(['transcribe', 'markdown'])
  })

  it('skips both extract and transcribe for an outdir target', async () => {
    const recorded = newRecorded()
    await runBook(OUTDIR_TARGET, NO_FLAGS, recordingSteps(recorded))
    expect(recorded.calls).toEqual(['markdown'])
  })

  it('appends the PDF export for --pdf, after markdown', async () => {
    const recorded = newRecorded()
    await runBook(
      PDF_TARGET,
      { ...NO_FLAGS, pdf: true },
      recordingSteps(recorded)
    )
    expect(recorded.calls).toEqual(['transcribe', 'markdown', 'pdf'])
  })

  it('appends the audio export for --audio, after markdown', async () => {
    const recorded = newRecorded()
    await runBook(
      PDF_TARGET,
      { ...NO_FLAGS, audio: true },
      recordingSteps(recorded)
    )
    expect(recorded.calls).toEqual(['transcribe', 'markdown', 'audio'])
  })

  it('runs markdown, then pdf, then audio for --all', async () => {
    const recorded = newRecorded()
    await runBook(
      PDF_TARGET,
      { ...NO_FLAGS, pdf: true, audio: true },
      recordingSteps(recorded)
    )
    expect(recorded.calls).toEqual(['transcribe', 'markdown', 'pdf', 'audio'])
  })

  it('threads the renamed out-dir from extraction into every later step', async () => {
    // extract-kindle-book renames out/<asin> to out/<asin>-<title> once the
    // title is known, so the pre-extraction outDir is stale.
    const renamed = path.join('out', 'ASIN000001-Example Book')
    const recorded = newRecorded()

    await runBook(
      KINDLE_TARGET,
      { ...NO_FLAGS, pdf: true, audio: true },
      recordingSteps(recorded, {
        extractKindleBook: async () => ({ outDir: renamed })
      })
    )

    const transcribeArgs = recorded.args.transcribe as [BookTarget, unknown]
    expect(transcribeArgs[0].outDir).toBe(renamed)

    for (const step of ['markdown', 'pdf', 'audio']) {
      const args = recorded.args[step] as [{ outDir: string }]
      expect(args[0].outDir).toBe(renamed)
    }
  })

  it('returns the renamed out-dir for a Kindle target', async () => {
    // The out-dir printed after a run (e.g. for the log path) must reflect
    // the post-rename directory, not the pre-extraction out/<asin> guess.
    const renamed = path.join('out', 'ASIN000001-Example Book')
    const recorded = newRecorded()

    const result = await runBook(
      KINDLE_TARGET,
      NO_FLAGS,
      recordingSteps(recorded, {
        extractKindleBook: async () => ({ outDir: renamed })
      })
    )

    expect(result).toEqual({ outDir: renamed })
  })

  it('returns the target out-dir unchanged for a non-Kindle target', async () => {
    const recorded = newRecorded()
    const result = await runBook(PDF_TARGET, NO_FLAGS, recordingSteps(recorded))
    expect(result).toEqual({ outDir: PDF_TARGET.outDir })
  })

  it('passes the source basename to the markdown export for a PDF target', async () => {
    const recorded = newRecorded()
    await runBook(PDF_TARGET, NO_FLAGS, recordingSteps(recorded))
    const args = recorded.args.markdown as [{ pdfBasename?: string }]
    expect(args[0].pdfBasename).toBe('example-book')
  })

  it('passes no basename to the markdown export for a Kindle target', async () => {
    const recorded = newRecorded()
    await runBook(KINDLE_TARGET, NO_FLAGS, recordingSteps(recorded))
    const args = recorded.args.markdown as [{ pdfBasename?: string }]
    expect(args[0].pdfBasename).toBeUndefined()
  })

  it('tells every logger-aware step to skip its own file logger', async () => {
    const recorded = newRecorded()
    await runBook(KINDLE_TARGET, NO_FLAGS, recordingSteps(recorded))

    const extractArgs = recorded.args.extract as [{ useFileLogger: boolean }]
    expect(extractArgs[0].useFileLogger).toBe(false)

    const transcribeArgs = recorded.args.transcribe as [
      BookTarget,
      { useFileLogger: boolean }
    ]
    expect(transcribeArgs[1].useFileLogger).toBe(false)

    const markdownArgs = recorded.args.markdown as [{ useFileLogger: boolean }]
    expect(markdownArgs[0].useFileLogger).toBe(false)
  })

  it('stops before any exporter when transcription throws', async () => {
    const recorded = newRecorded()
    const steps = recordingSteps(recorded, {
      transcribeBookContent: async () => {
        throw new Error('OCR exploded')
      }
    })

    await expect(runBook(PDF_TARGET, NO_FLAGS, steps)).rejects.toThrow()
    expect(recorded.calls).toEqual([])
  })

  it('tags a transcription failure with its step label', async () => {
    const steps = recordingSteps(newRecorded(), {
      transcribeBookContent: async () => {
        throw new Error('OCR exploded')
      }
    })

    await expect(runBook(PDF_TARGET, NO_FLAGS, steps)).rejects.toMatchObject({
      label: 'Transcription failed'
    })
  })

  it('preserves the original error as the cause', async () => {
    const original = new Error('OCR exploded')
    const steps = recordingSteps(newRecorded(), {
      transcribeBookContent: async () => {
        throw original
      }
    })

    await expect(runBook(PDF_TARGET, NO_FLAGS, steps)).rejects.toSatisfy(
      (err: unknown) => err instanceof BookStepError && err.cause === original
    )
  })

  it('tags an extraction failure with its own label', async () => {
    const steps = recordingSteps(newRecorded(), {
      extractKindleBook: async () => {
        throw new Error('Amazon 403')
      }
    })

    await expect(runBook(KINDLE_TARGET, NO_FLAGS, steps)).rejects.toMatchObject(
      { label: 'Extraction failed' }
    )
  })

  it('stops before the audio export when the PDF export throws', async () => {
    const recorded = newRecorded()
    const steps = recordingSteps(recorded, {
      exportBookPdf: async () => {
        throw new Error('missing toc')
      }
    })

    await expect(
      runBook(PDF_TARGET, { ...NO_FLAGS, pdf: true, audio: true }, steps)
    ).rejects.toMatchObject({ label: 'PDF export failed' })
    expect(recorded.calls).not.toContain('audio')
  })

  // The out-dir rename must be last: it moves the directory every earlier step
  // writes into, and repoints the paths recorded inside content/metadata.json.
  it('renames the out dir only after every export has finished', async () => {
    const recorded = newRecorded()
    const steps = recordingSteps(recorded)

    await runBook(
      KINDLE_TARGET,
      { pdf: true, audio: true, force: false },
      steps
    )

    expect(recorded.calls).toEqual([
      'extract',
      'transcribe',
      'markdown',
      'pdf',
      'audio',
      'rename'
    ])
  })

  it('passes the asin and post-extraction out dir to the rename', async () => {
    const recorded = newRecorded()

    await runBook(KINDLE_TARGET, NO_FLAGS, recordingSteps(recorded))

    const args = recorded.args.rename as [{ outDir: string; asin: string }]
    expect(args[0]).toEqual({
      outDir: KINDLE_TARGET.outDir,
      asin: 'ASIN000001'
    })
  })

  it('returns the renamed directory so callers report the final path', async () => {
    const renamedDir = path.join('out', 'ASIN000001-Example Book')
    const steps = recordingSteps(newRecorded(), {
      renameBookDir: (async () => ({
        renamed: true,
        outDir: renamedDir
      })) as BookSteps['renameBookDir']
    })

    const result = await runBook(KINDLE_TARGET, NO_FLAGS, steps)

    expect(result.outDir).toBe(renamedDir)
  })

  // PDF and EPUB out-dirs are named from the source file, never from an ASIN.
  it('does not rename for a PDF target', async () => {
    const recorded = newRecorded()

    await runBook(PDF_TARGET, NO_FLAGS, recordingSteps(recorded))

    expect(recorded.calls).not.toContain('rename')
  })

  it('does not rename for an EPUB target', async () => {
    const recorded = newRecorded()

    await runBook(EPUB_TARGET, NO_FLAGS, recordingSteps(recorded))

    expect(recorded.calls).not.toContain('rename')
  })

  // The rename is cosmetic: everything the user asked for is already on disk
  // by the time it runs, so a failure must not fail the run.
  it('still succeeds when the rename throws', async () => {
    const recorded = newRecorded()
    const steps = recordingSteps(recorded, {
      renameBookDir: (async () => {
        throw new Error('EPERM')
      }) as BookSteps['renameBookDir']
    })

    const result = await runBook(KINDLE_TARGET, NO_FLAGS, steps)

    expect(result.outDir).toBe(KINDLE_TARGET.outDir)
    expect(recorded.calls).toContain('markdown')
  })
})
