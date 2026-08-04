import type { BookFlags } from './book-flags'
import type { BookTarget } from './book-input'
import type { ExportBookMarkdownOptions } from './export-book-markdown'

/**
 * Wraps a step failure with the label its standalone script would have
 * printed, so `book.ts` can report which step died without the caller having
 * to infer it from the stack.
 */
export class BookStepError extends Error {
  readonly label: string

  constructor(label: string, cause: unknown) {
    // Use the native Error `cause` option rather than declaring an own `cause`
    // field: tsconfig sets `useDefineForClassFields: true`, so a declared field
    // shadowing the base property is a footgun for no benefit.
    super(label, { cause })
    this.name = 'BookStepError'
    this.label = label
  }
}

export interface BookSteps {
  extractKindleBook: (opts: {
    asin: string
    useFileLogger: boolean
  }) => Promise<{ outDir: string }>
  transcribeBookContent: (
    target: BookTarget,
    opts: { useFileLogger: boolean }
  ) => Promise<unknown>
  exportBookMarkdown: (opts: ExportBookMarkdownOptions) => Promise<unknown>
  exportBookPdf: (opts: { outDir: string }) => Promise<unknown>
  exportBookAudio: (opts: { outDir: string }) => Promise<unknown>
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new BookStepError(label, err)
  }
}

/**
 * Run the pipeline for one book: extract (Kindle only) → transcribe → export.
 *
 * Steps are injected so the sequence is testable without a browser, the
 * OpenAI API, or the filesystem. Fails fast: the first step to throw aborts
 * the run, so a `--pdf` failure still leaves the markdown on disk.
 */
export async function runBook(
  target: BookTarget,
  flags: BookFlags,
  steps: BookSteps
): Promise<void> {
  // Extraction renames out/<asin> to out/<asin>-<title> once the title is
  // known, so its returned directory supersedes the one resolved up front.
  const extracted =
    target.kind === 'kindle'
      ? await step('Extraction failed', () =>
          steps.extractKindleBook({ asin: target.asin, useFileLogger: false })
        )
      : undefined

  const resolved: BookTarget = extracted
    ? { ...target, outDir: extracted.outDir }
    : target

  if (resolved.kind !== 'outdir') {
    await step('Transcription failed', () =>
      steps.transcribeBookContent(resolved, { useFileLogger: false })
    )
  }

  const pdfBasename =
    resolved.kind === 'pdf' || resolved.kind === 'epub'
      ? resolved.basename
      : undefined

  await step('Markdown export failed', () =>
    steps.exportBookMarkdown({
      outDir: resolved.outDir,
      pdfBasename,
      useFileLogger: false
    })
  )

  if (flags.pdf) {
    await step('PDF export failed', () =>
      steps.exportBookPdf({ outDir: resolved.outDir })
    )
  }

  if (flags.audio) {
    await step('Audio export failed', () =>
      steps.exportBookAudio({ outDir: resolved.outDir })
    )
  }
}
