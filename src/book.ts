import 'dotenv/config'

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { BOOK_USAGE, parseBookFlags } from './book-flags'
import type { BookFlags } from './book-flags'
import { resolveBookTarget } from './book-input'
import type { BookTarget } from './book-input'
import { checkPreflight } from './book-preflight'
import type { PreflightProbes, SourceFileProbe } from './book-preflight'
import type { ExportBookMarkdownOptions } from './export-book-markdown'
import { fileExists, reportFatalError, setupTimestampedLogger } from './utils'

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
  renameBookDir: (opts: {
    outDir: string
    asin: string
  }) => Promise<{ renamed: boolean; outDir: string }>
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
 *
 * Returns the final out-dir. For a Kindle target this supersedes the one
 * resolved before the run started, since extraction renames `out/<asin>` to
 * `out/<asin>-<title>` once the title is known.
 */
export async function runBook(
  target: BookTarget,
  flags: BookFlags,
  steps: BookSteps
): Promise<{ outDir: string }> {
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

  // Name the out-dir after the book, last.
  //
  // Extraction already does this as soon as Amazon's metadata arrives, and does
  // it early so every recorded path is written with the final name. When that
  // metadata never arrives the title is instead recovered by OCR during
  // transcription, far too late for that rename — so catch it here, once every
  // step that writes into the directory has finished.
  //
  // Deliberately outside `step()`: everything the user asked for is already on
  // disk, so a rename that fails (a permission error, an open file handle on
  // Windows) must not turn a successful run into a failed one.
  if (resolved.kind === 'kindle') {
    try {
      const renamed = await steps.renameBookDir({
        outDir: resolved.outDir,
        asin: resolved.asin
      })
      return { outDir: renamed.outDir }
    } catch (err: any) {
      console.warn(
        `⚠️  Could not rename the output directory: ${err?.message ?? String(err)}`
      )
    }
  }

  return { outDir: resolved.outDir }
}

// Dynamic imports keep the heavy dependencies out of runs that don't need
// them: Playwright (extract) and fluent-ffmpeg + unrealspeech-api (audio)
// would otherwise load on every plain PDF-to-markdown run.
const defaultBookSteps: BookSteps = {
  extractKindleBook: async (opts) =>
    (await import('./extract-kindle-book')).extractKindleBook(opts),
  transcribeBookContent: async (target, opts) =>
    (await import('./transcribe-book-content')).transcribeBookContent(
      target,
      opts
    ),
  exportBookMarkdown: async (opts: ExportBookMarkdownOptions) =>
    (await import('./export-book-markdown')).exportBookMarkdown(opts),
  exportBookPdf: async (opts) =>
    (await import('./export-book-pdf')).exportBookPdf(opts),
  exportBookAudio: async (opts) =>
    (await import('./export-book-audio')).exportBookAudio(opts),
  renameBookDir: async (opts) => {
    const { renameBookDir } = await import('./rename-book-dir')
    const result = await renameBookDir(opts, {
      readFile: (p) => fs.readFile(p, 'utf8'),
      writeFile: (p, data) => fs.writeFile(p, data),
      rename: (from, to) => fs.rename(from, to),
      exists: fileExists
    })
    if (result.renamed) {
      console.warn(
        `📁 Renamed output directory to ${path.basename(result.to!)} ` +
          `(repointed ${result.rewritten} recorded page path(s))`
      )
    }
    return result
  }
}

const execFileAsync = promisify(execFile)

async function probeFfmpeg(): Promise<boolean> {
  // fluent-ffmpeg honours FFMPEG_PATH, so probe the same binary it will use.
  const bin = process.env.FFMPEG_PATH || 'ffmpeg'
  try {
    await execFileAsync(bin, ['-version'])
    return true
  } catch {
    return false
  }
}

async function probeSourceFile(filePath: string): Promise<SourceFileProbe> {
  if (!(await fileExists(filePath, constants.F_OK))) return 'missing'
  // Distinct from 'missing': macOS iCloud Drive files exist but fail R_OK with
  // EPERM until the terminal is granted Full Disk Access.
  if (!(await fileExists(filePath, constants.R_OK))) return 'unreadable'
  return 'ok'
}

async function probe(
  target: BookTarget,
  flags: BookFlags
): Promise<PreflightProbes> {
  const hasFfmpeg = flags.audio ? await probeFfmpeg() : true

  switch (target.kind) {
    case 'pdf':
    case 'epub':
      return { hasFfmpeg, sourceFile: await probeSourceFile(target.sourcePath) }
    case 'outdir':
      return {
        hasFfmpeg,
        hasContentJson: await fileExists(
          path.join(target.outDir, 'content.json')
        )
      }
    case 'kindle':
      return { hasFfmpeg }
  }
}

// Usage errors — an unknown flag, a missing input — are not pipeline
// failures: nothing has run yet. Report the message alone, without
// reportFatalError's stack trace or its "Book pipeline failed" framing.
function reportUsageError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  // A help request is a success, not a usage error — and must be handled
  // before any parsing so `--help`/`-h` can never be misclassified as an
  // <input> (see book-input.ts's leading-dash guard) or touch the filesystem.
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(`${BOOK_USAGE}\n`)
    process.exit(0)
  }

  const [input, ...flagArgs] = process.argv.slice(2)

  let flags: BookFlags
  let target: BookTarget
  try {
    // Target resolves before flags parse. `input` is whatever landed in
    // position 0; classifyBookArg (book-input.ts) rejects a leading dash, so
    // `pnpm book --pfd example.pdf` reports "--pfd" as the unknown flag
    // instead of misreporting the unrelated tail argument "example.pdf".
    target = await resolveBookTarget(input)
    flags = parseBookFlags(flagArgs)
  } catch (err) {
    reportUsageError(err)
  }

  // Set FORCE for the whole process so each step's existing getEnv('FORCE')
  // check sees it, rather than threading a parameter through five call sites.
  if (flags.force) {
    process.env.FORCE = 'true'
  }

  const problems = checkPreflight(
    target,
    flags,
    process.env,
    await probe(target, flags)
  )
  if (problems.length > 0) {
    // Also not a pipeline failure — nothing has run yet — so report directly
    // rather than through reportFatalError (which would stack-trace a plain
    // string and glue "Preflight failed: " onto a message that already
    // starts with its own newline).
    process.stderr.write(
      `\n❌ Preflight failed:\n${problems.map((p) => `  - ${p}\n`).join('')}`
    )
    process.exit(1)
  }

  // One shared log file for the whole run. Without this each step installs its
  // own and a single export scatters output across several files.
  await fs.mkdir(target.outDir, { recursive: true })
  const { logPath } = await setupTimestampedLogger(target.outDir)

  let finalOutDir: string
  try {
    const result = await runBook(target, flags, defaultBookSteps)
    finalOutDir = result.outDir
  } catch (err) {
    // console.* is redirected to the log file for the whole run, so without
    // this a failed run leaves a one-line error and no pointer to the file
    // holding the detail. Plain path, no stack trace — reportFatalError
    // (called by the entry guard below) adds that separately.
    process.stderr.write(`Log: ${logPath}\n`)
    throw err
  }

  // Extraction may have renamed target.outDir (out/<asin> → out/<asin>-<title>),
  // so recompute the printed path from the final out-dir rather than reusing
  // logPath's now possibly-stale directory.
  const finalLogPath = path.join(finalOutDir, 'logs', path.basename(logPath))

  // console.* is redirected to the log file at this point, so write the
  // summary to the real stdout.
  process.stdout.write(`\n✅ Done. Log: ${finalLogPath}\n`)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr (the console is redirected to the log file).
    if (err instanceof BookStepError) {
      reportFatalError(err.label, err.cause)
    } else {
      reportFatalError('Book pipeline failed', err)
    }
    process.exit(1)
  }
}
