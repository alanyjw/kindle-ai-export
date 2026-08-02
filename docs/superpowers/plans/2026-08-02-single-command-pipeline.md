# Single-command pipeline (`pnpm book`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-or-three-command export workflow with a single `pnpm book <input>` that auto-detects PDF, EPUB, Kindle ASIN, and `out/` directory inputs and runs the whole pipeline in one process.

**Architecture:** Three pure modules (`book-flags`, `book-input`, `book-preflight`) feed an orchestrator (`book.ts`) that calls step functions extracted from the five existing pipeline scripts. Each script keeps its `main()` and CLI behavior behind an entry guard, so nothing that works today stops working. `runBook` takes its steps as an injected dependency so the orchestration sequence is testable without a browser, the OpenAI API, or the filesystem.

**Tech Stack:** TypeScript (strict, ES modules, bundler resolution), Node ≥20, pnpm, tsx, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-single-command-pipeline-design.md`

## Global Constraints

- **Package manager is pnpm.** `npm`/`yarn` are blocked by the `preinstall` script. Run tests with `pnpm test` / `npx vitest run <file>`.
- **ES modules only.** `"type": "module"`. Use `import`, never `require`. Relative imports have no file extension in this codebase (`from './utils'`, not `'./utils.js'`).
- **TypeScript strict mode.** No `any` in new code; use `unknown` and narrow. Explicit parameter and return types on every exported function.
- **Immutability in `src/*.ts` modules.** Never mutate an existing object or array. Build new values with spread / `concat` / `reduce`. (Test helpers that record calls into an accumulator are exempt — that's what a spy is.)
- **No `console.log` for control flow in new modules.** The pure modules return values; only `book.ts` prints.
- **`noUncheckedIndexedAccess: true`.** Indexing an array or `Record` yields `T | undefined`. Destructuring `process.argv.slice(2)` gives `string | undefined` — which is exactly what `resolveBookTarget` and `classifyBookArg` accept, so no non-null assertion is needed.
- **No `exactOptionalPropertyTypes`.** Passing `pdfBasename: undefined` to an optional property is legal.
- **Privacy — enforced by a git hook that will reject the commit.** Test fixtures and docs must NEVER contain real book titles, real author names, or ASINs beginning with `B0`. Use `ASIN000001`, `"Example Book"`, `"Author Name"`. The single permitted real ASIN is the documented public sample `B0819W19WD`.
- **The PII hook also rejects an Amazon credential key written immediately followed by a colon-or-equals and a value** (`.githooks/scan-pii.mjs:50`, pattern `/AMAZON_(?:EMAIL|PASSWORD)\s*[:=]\s*['"]?[^'"\s]+/gi`). This fires even when the value is the literal `undefined` in a test fixture. Task 3's fixtures therefore build those two keys programmatically via `CREDENTIAL_KEYS` and subtract them with `envWithout(…)`. Do not "simplify" them back into inline key-value literals — the commit will be rejected. Referring to a key on its own is fine: `envWithout('AMAZON_EMAIL')`, `env.AMAZON_EMAIL`, an optional-property declaration, or a mention inside a message string all pass. Only the key-adjacent-to-value shape matches.
- **Prettier + ESLint gate every commit.** Run `pnpm test:format:fix && pnpm test:lint:fix` before committing if either complains.
- **Every task ends green.** `pnpm test` (format, lint, typecheck, unit) must pass before each commit.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/book-flags.ts` | Pure CLI flag parsing → `BookFlags` |
| `src/book-input.ts` | Pure input classification + async out-dir resolution → `BookTarget` |
| `src/book-preflight.ts` | Pure requirement checking → `string[]` of unmet requirements |
| `src/book.ts` | Orchestrator: `runBook()` + the CLI entry point |
| `src/__tests__/book-flags.test.ts` | Tests for `parseBookFlags` |
| `src/__tests__/book-input.test.ts` | Tests for `classifyBookArg` / `resolveBookTarget` |
| `src/__tests__/book-preflight.test.ts` | Tests for `checkPreflight` |
| `src/__tests__/run-book.test.ts` | Tests for `runBook` with injected fake steps |

**Modified files**

| File | Change |
|---|---|
| `src/export-book-pdf.ts` | Extract `exportBookPdf({ outDir })`; add entry guard; use `resolveBookTarget` |
| `src/export-book-audio.ts` | Extract `exportBookAudio({ outDir })`; add entry guard; accept an input argument |
| `src/export-book-markdown.ts` | `main()` switches to `resolveBookTarget` |
| `src/transcribe-book-content.ts` | Export `transcribeBookContent(target, opts)`; `main()` becomes arg-parsing |
| `src/extract-kindle-book.ts` | Export `extractKindleBook({ asin, useFileLogger })` returning `{ outDir }`; add entry guard |
| `package.json` | Add `"book": "tsx src/book.ts"` |
| `CLAUDE.md` | Document `pnpm book` as the primary workflow |

**Task order rationale:** the three pure modules come first because everything else imports them. The script refactors come next (each independently reviewable and testable). `runBook` needs the step signatures to exist. The CLI wiring comes last because it needs all of the above.

---

### Task 1: `book-flags.ts` — pure flag parsing

**Files:**
- Create: `src/book-flags.ts`
- Test: `src/__tests__/book-flags.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface BookFlags { pdf: boolean; audio: boolean; force: boolean }`, `function parseBookFlags(argv: readonly string[]): BookFlags`, `const BOOK_USAGE: string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/book-flags.test.ts`:

```ts
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
    expect(parseBookFlags(['--all'])).toEqual(parseBookFlags(['--pdf', '--audio']))
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
    expect(parseBookFlags(['--pdf', '--pdf'])).toEqual(parseBookFlags(['--pdf']))
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/book-flags.test.ts`
Expected: FAIL — `Failed to resolve import "../book-flags"`.

- [ ] **Step 3: Write the implementation**

Create `src/book-flags.ts`:

```ts
export interface BookFlags {
  pdf: boolean
  audio: boolean
  force: boolean
}

export const BOOK_USAGE = `Usage: pnpm book <input> [flags]

  <input>
    book.pdf     transcribe from PDF, then export
    book.epub    transcribe from EPUB, then export
    B0819W19WD   Kindle ASIN — extract, transcribe, then export
    out/<dir>    skip extract + transcribe; re-export from existing content.json

  flags
    --pdf        also export book.pdf
    --audio      also export the audiobook
    --all        equivalent to --pdf --audio
    --force      re-run steps that would otherwise no-op`

const NO_FLAGS: BookFlags = { pdf: false, audio: false, force: false }

// Parses everything after the <input> argument. Unknown tokens are a hard
// error rather than being ignored, so a typo like `--pfd` fails loudly instead
// of silently skipping the PDF export.
export function parseBookFlags(argv: readonly string[]): BookFlags {
  return argv.reduce<BookFlags>((flags, arg) => {
    switch (arg) {
      case '--pdf':
        return { ...flags, pdf: true }
      case '--audio':
        return { ...flags, audio: true }
      case '--all':
        return { ...flags, pdf: true, audio: true }
      case '--force':
        return { ...flags, force: true }
      default:
        throw new Error(`Unknown flag: ${arg}\n\n${BOOK_USAGE}`)
    }
  }, NO_FLAGS)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/book-flags.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: format, lint, typecheck, and unit all pass.

- [ ] **Step 6: Commit**

```bash
git add src/book-flags.ts src/__tests__/book-flags.test.ts
git commit -m "feat(book): add pure CLI flag parsing"
```

---

### Task 2: `book-input.ts` — pure input classification

**Files:**
- Create: `src/book-input.ts`
- Test: `src/__tests__/book-input.test.ts`

**Interfaces:**
- Consumes: `BOOK_USAGE` from `./book-flags` (Task 1); `resolveOutDir`, `sanitizeDirname` from `./utils`
- Produces:
  - `type BookArg = { kind: 'pdf'; sourcePath: string; basename: string } | { kind: 'epub'; sourcePath: string; basename: string } | { kind: 'kindle'; asin: string } | { kind: 'outdir'; outDir: string }`
  - `type BookTarget = BookArg & { outDir: string }`
  - `function classifyBookArg(arg: string | undefined, isExistingDir?: (p: string) => boolean): BookArg`
  - `function resolveBookTarget(arg: string | undefined, isExistingDir?: (p: string) => boolean): Promise<BookTarget>`

**Existing behavior this must reproduce exactly** (it replaces three copies):
- `transcribe-book-content.ts:545`, `export-book-markdown.ts:433`, `export-book-pdf.ts:17`
- PDF/EPUB → `path.join('out', sanitizeDirname(basenameWithoutExt))`, a **relative** path
- An `out/` dir arg → `path.resolve(arg)`, an **absolute** path
- ASIN → `await resolveOutDir(asin)` (`utils.ts:80`), which prefers `out/<asin>-<title>` over `out/<asin>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/book-input.test.ts`:

```ts
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
    expect(() => classifyBookArg(undefined, noDirs)).toThrow(/input is required/)
  })

  it('throws on an empty or whitespace-only string', () => {
    expect(() => classifyBookArg('', noDirs)).toThrow(/input is required/)
    expect(() => classifyBookArg('   ', noDirs)).toThrow(/input is required/)
  })

  it('includes usage text in the missing-input error', () => {
    expect(() => classifyBookArg(undefined, noDirs)).toThrow(/pnpm book <input>/)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/book-input.test.ts`
Expected: FAIL — `Failed to resolve import "../book-input"`.

- [ ] **Step 3: Write the implementation**

Create `src/book-input.ts`:

```ts
import { statSync } from 'node:fs'
import path from 'node:path'

import { BOOK_USAGE } from './book-flags'
import { resolveOutDir, sanitizeDirname } from './utils'

export type BookArg =
  | { kind: 'pdf'; sourcePath: string; basename: string }
  | { kind: 'epub'; sourcePath: string; basename: string }
  | { kind: 'kindle'; asin: string }
  | { kind: 'outdir'; outDir: string }

export type BookTarget = BookArg & { outDir: string }

const PDF_RE = /\.pdf$/i
const EPUB_RE = /\.epub$/i

function defaultIsExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Classify a CLI input into one of the four pipeline entry shapes.
 *
 * Rule order matters. An ASIN is an opaque alphanumeric string, so shape alone
 * cannot distinguish it from a bare directory name — a path separator is the
 * reliable discriminator (`out/ASIN000001` has one, an ASIN never does), with
 * on-disk existence as the fallback for a bare directory name.
 *
 * `isExistingDir` is injected so this stays a pure function under test.
 */
export function classifyBookArg(
  arg: string | undefined,
  isExistingDir: (p: string) => boolean = defaultIsExistingDir
): BookArg {
  const input = arg?.trim()
  if (!input) {
    throw new Error(`an input is required\n\n${BOOK_USAGE}`)
  }

  if (PDF_RE.test(input) || EPUB_RE.test(input)) {
    const sourcePath = path.resolve(input)
    const basename = sanitizeDirname(
      path.basename(sourcePath, path.extname(sourcePath))
    )
    return PDF_RE.test(input)
      ? { kind: 'pdf', sourcePath, basename }
      : { kind: 'epub', sourcePath, basename }
  }

  const hasSeparator = input.includes('/') || input.includes(path.sep)
  if (hasSeparator || isExistingDir(input)) {
    return { kind: 'outdir', outDir: path.resolve(input) }
  }

  return { kind: 'kindle', asin: input }
}

/**
 * Classify an input and attach the output directory it maps to.
 *
 * Async only for the Kindle case, which needs resolveOutDir()'s scan for an
 * `out/<asin>-<title>` directory (utils.ts:80).
 *
 * Callers that need the historical `ASIN`-from-env fallback should pass
 * `process.argv[2] ?? getEnv('ASIN')`. `book.ts` deliberately does not.
 */
export async function resolveBookTarget(
  arg: string | undefined,
  isExistingDir?: (p: string) => boolean
): Promise<BookTarget> {
  const classified = classifyBookArg(arg, isExistingDir)

  switch (classified.kind) {
    case 'pdf':
    case 'epub':
      return { ...classified, outDir: path.join('out', classified.basename) }
    case 'kindle':
      return { ...classified, outDir: await resolveOutDir(classified.asin) }
    case 'outdir':
      return classified
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/book-input.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/book-input.ts src/__tests__/book-input.test.ts
git commit -m "feat(book): add pure input classification and target resolution"
```

---

### Task 3: `book-preflight.ts` — pure requirement checking

**Files:**
- Create: `src/book-preflight.ts`
- Test: `src/__tests__/book-preflight.test.ts`

**Interfaces:**
- Consumes: `BookFlags` (Task 1), `BookTarget` (Task 2)
- Produces:
  - `type SourceFileProbe = 'ok' | 'missing' | 'unreadable'`
  - `interface PreflightEnv { TTS_ENGINE?, OPENAI_API_KEY?, UNREAL_SPEECH_API_KEY?, AMAZON_EMAIL?, AMAZON_PASSWORD? }` (all `string | undefined`)
  - `interface PreflightProbes { hasFfmpeg: boolean; sourceFile?: SourceFileProbe; hasContentJson?: boolean }`
  - `function checkPreflight(target: BookTarget, flags: BookFlags, env: PreflightEnv, probes: PreflightProbes): string[]`

**Why this exists:** audio runs last, after a transcription that can take many minutes. A missing `OPENAI_API_KEY` or absent `ffmpeg` must not be discovered at the end of that.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/book-preflight.test.ts`:

```ts
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
    expect(checkPreflight(PDF_TARGET, NO_FLAGS, FULL_ENV, OK_PROBES)).toEqual([])
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/book-preflight.test.ts`
Expected: FAIL — `Failed to resolve import "../book-preflight"`.

- [ ] **Step 3: Write the implementation**

Create `src/book-preflight.ts`:

```ts
import type { BookFlags } from './book-flags'
import type { BookTarget } from './book-input'

export type SourceFileProbe = 'ok' | 'missing' | 'unreadable'

export interface PreflightEnv {
  TTS_ENGINE?: string | undefined
  OPENAI_API_KEY?: string | undefined
  UNREAL_SPEECH_API_KEY?: string | undefined
  AMAZON_EMAIL?: string | undefined
  AMAZON_PASSWORD?: string | undefined
}

export interface PreflightProbes {
  hasFfmpeg: boolean
  sourceFile?: SourceFileProbe | undefined
  hasContentJson?: boolean | undefined
}

function audioProblems(
  flags: BookFlags,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  if (!flags.audio) return []

  // Mirrors the engine default in export-book-audio.ts:66.
  const engine = env.TTS_ENGINE || 'openai'
  const credential =
    engine === 'unrealspeech'
      ? { name: 'UNREAL_SPEECH_API_KEY', value: env.UNREAL_SPEECH_API_KEY }
      : { name: 'OPENAI_API_KEY', value: env.OPENAI_API_KEY }

  return [
    ...(credential.value
      ? []
      : [
          `--audio requires ${credential.name} (TTS_ENGINE=${engine}); set it in .env`
        ]),
    ...(probes.hasFfmpeg
      ? []
      : ['--audio requires ffmpeg on PATH; install it with `brew install ffmpeg`'])
  ]
}

function targetProblems(
  target: BookTarget,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  switch (target.kind) {
    case 'kindle':
      return [
        ...(env.AMAZON_EMAIL
          ? []
          : ['AMAZON_EMAIL is required to extract a Kindle book; set it in .env']),
        ...(env.AMAZON_PASSWORD
          ? []
          : [
              'AMAZON_PASSWORD is required to extract a Kindle book; set it in .env'
            ])
      ]

    case 'pdf':
    case 'epub':
      if (probes.sourceFile === 'missing') {
        return [`source file not found: ${target.sourcePath}`]
      }
      if (probes.sourceFile === 'unreadable') {
        return [
          `source file exists but could not be read: ${target.sourcePath}\n` +
            '    On macOS, files in iCloud Drive fail with EPERM until the terminal is\n' +
            '    granted Full Disk Access (System Settings → Privacy & Security).'
        ]
      }
      return []

    case 'outdir':
      return probes.hasContentJson
        ? []
        : [`no content.json in ${target.outDir}; nothing to export`]
  }
}

/**
 * Return human-readable descriptions of every unmet requirement, or an empty
 * array when the run can proceed.
 *
 * Pure: the caller performs the I/O probes (a PATH lookup for ffmpeg, an R_OK
 * access check on the source file) and passes the results in.
 */
export function checkPreflight(
  target: BookTarget,
  flags: BookFlags,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  return [
    ...audioProblems(flags, env, probes),
    ...targetProblems(target, env, probes)
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/book-preflight.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/book-preflight.ts src/__tests__/book-preflight.test.ts
git commit -m "feat(book): add pure preflight requirement checking"
```

---

### Task 4: `export-book-pdf.ts` — extract a callable step

**Files:**
- Modify: `src/export-book-pdf.ts` (whole file — it is 133 lines)

**Interfaces:**
- Consumes: `resolveBookTarget` (Task 2)
- Produces: `interface ExportBookPdfOptions { outDir: string }`, `function exportBookPdf(opts: ExportBookPdfOptions): Promise<{ pdfPath: string }>`

**Critical detail:** this file currently calls `await main()` unguarded at line 133. Importing it from `book.ts` would run a full PDF export at import time. It needs the same entry guard `export-book-markdown.ts:458` uses.

**Do NOT add a `useFileLogger` option here.** This script never calls `setupTimestampedLogger`, so there is no logger to suppress. Adding one would give it file logging it doesn't have today, changing its standalone output.

- [ ] **Step 1: Replace `resolveOutDirArg` and wrap the body in an exported function**

Replace lines 1–34 of `src/export-book-pdf.ts` (the imports, `resolveOutDirArg`, and the `main()` signature through `const outDir = await resolveOutDirArg()`) with:

```ts
import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import PDFDocument from 'pdfkit'

import { resolveBookMeta } from './book-meta'
import { resolveBookTarget } from './book-input'
import type { BookMetadata, ContentChunk } from './types'
import { assert, getEnv, reportFatalError } from './utils'

export interface ExportBookPdfOptions {
  outDir: string
}

export async function exportBookPdf(
  opts: ExportBookPdfOptions
): Promise<{ pdfPath: string }> {
  const { outDir } = opts
```

- [ ] **Step 2: Return the written path and close the function**

Replace the tail of the old `main()` (from `doc.end()` through the final `await main()` at line 133) with:

```ts
  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve())
    stream.on('error', (err) => reject(err))
  })

  return { pdfPath }
}

async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior of falling back to ASIN from .env.
  const target = await resolveBookTarget(process.argv[2] ?? getEnv('ASIN'))
  await exportBookPdf({ outDir: target.outDir })
}

// Only auto-run when invoked directly, so importing this module (from book.ts
// or a test) doesn't kick off a PDF export.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr and exit non-zero so a `&&` chain stops here.
    reportFatalError('PDF export failed', err)
    process.exit(1)
  }
}
```

- [ ] **Step 3: Introduce the `pdfPath` local**

Inside `exportBookPdf`, replace the existing stream line:

```ts
  const stream = doc.pipe(fs.createWriteStream(path.join(outDir, 'book.pdf')))
```

with:

```ts
  const pdfPath = path.join(outDir, 'book.pdf')
  const stream = doc.pipe(fs.createWriteStream(pdfPath))
```

- [ ] **Step 4: Verify the imports are exactly what's used**

`resolveOutDir` and `sanitizeDirname` are no longer used in this file (they moved into `book-input.ts`). Confirm they are gone from the import list, and that `getEnv`, `assert`, and `reportFatalError` remain.

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS. A `'resolveOutDir' is defined but never used` lint error means Step 1 was applied incompletely.

- [ ] **Step 5: Verify the entry guard works**

Run: `npx tsx -e "const m = await import('./src/export-book-pdf.ts'); console.log(typeof m.exportBookPdf)"`
Expected: prints `function` and exits immediately — **no** PDF export runs and no error about a missing `content.json`. If it tries to export, the entry guard is wrong.

- [ ] **Step 6: Verify the CLI still works**

Run: `pnpm tsx src/export-book-pdf.ts 2>&1 | head -5`
Expected: without `ASIN` in `.env`, it fails with `❌ PDF export failed: … ASIN is required`. With a valid `ASIN` or an `out/<dir>` argument pointing at a transcribed book, it writes `book.pdf`. Either outcome proves the CLI path is wired; a crash mentioning `resolveOutDirArg` or an unguarded import does not.

- [ ] **Step 7: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/export-book-pdf.ts
git commit -m "refactor(export-pdf): extract exportBookPdf and add entry guard"
```

---

### Task 5: `export-book-audio.ts` — extract a callable step and accept an input argument

**Files:**
- Modify: `src/export-book-audio.ts:26-45` (the head of `main()`) and `:397` (the unguarded call)

**Interfaces:**
- Consumes: `resolveBookTarget` (Task 2)
- Produces: `interface ExportBookAudioOptions { outDir: string }`, `function exportBookAudio(opts: ExportBookAudioOptions): Promise<void>`

**Why this is more than a refactor:** `export-book-audio.ts:27` reads `ASIN` from env and accepts no CLI argument, so PDF- and EPUB-sourced books **cannot currently produce an audiobook at all** — there is no ASIN to resolve them. An explicit `outDir` fixes that.

**Keep `preview` and `force` reading from env** (`AUDIOBOOK_PREVIEW`, `FORCE`) inside the function. They are not parameters. `book.ts` sets `process.env.FORCE` for `--force`, and `AUDIOBOOK_PREVIEW=true pnpm book <input> --audio` keeps working unchanged.

**Do NOT add a `useFileLogger` option here** — this script never calls `setupTimestampedLogger`.

- [ ] **Step 1: Convert `main()` into `exportBookAudio()`**

Replace lines 26–36 of `src/export-book-audio.ts`:

```ts
async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  // If force mode, we'll always regenerate all of the audio files.
  const force = getEnv('FORCE') === 'true'

  // In preview mode, we only export the first page of the book.
  const isPreview = getEnv('AUDIOBOOK_PREVIEW') === 'true'

  const outDir = await resolveOutDir(asin)
  const audioOutDir = path.join(outDir, isPreview ? 'audio-previews' : 'audio')
```

with:

```ts
export interface ExportBookAudioOptions {
  outDir: string
}

export async function exportBookAudio(
  opts: ExportBookAudioOptions
): Promise<void> {
  const { outDir } = opts

  // If force mode, we'll always regenerate all of the audio files.
  const force = getEnv('FORCE') === 'true'

  // In preview mode, we only export the first page of the book.
  const isPreview = getEnv('AUDIOBOOK_PREVIEW') === 'true'

  const audioOutDir = path.join(outDir, isPreview ? 'audio-previews' : 'audio')
```

- [ ] **Step 2: Add the CLI wrapper and entry guard**

Replace line 397 (`await main()`) with:

```ts
async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior. The positional argument is new: it lets PDF- and EPUB-sourced
  // books reach an out-dir, which an ASIN lookup alone could never do.
  const target = await resolveBookTarget(process.argv[2] ?? getEnv('ASIN'))
  await exportBookAudio({ outDir: target.outDir })
}

// Only auto-run when invoked directly, so importing this module (from book.ts
// or a test) doesn't kick off an audiobook export.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr and exit non-zero so a `&&` chain stops here.
    reportFatalError('Audio export failed', err)
    process.exit(1)
  }
}
```

- [ ] **Step 3: Fix the imports**

At the top of `src/export-book-audio.ts`, add `import { pathToFileURL } from 'node:url'` after the other `node:` imports, add `import { resolveBookTarget } from './book-input'`, and update the `./utils` import list: **remove** `resolveOutDir`, **add** `reportFatalError`.

The resulting `./utils` import should be:

```ts
import {
  assert,
  ffmpegOnProgress,
  fileExists,
  getEnv,
  hashObject,
  reportFatalError
} from './utils'
```

- [ ] **Step 4: Check whether `assert` is still used**

`assert` was used for `assert(asin, 'ASIN is required')`, which Step 1 deleted. Search the file:

Run: `grep -n "assert(" src/export-book-audio.ts`

If there are no remaining uses, remove `assert` from the import list. If there are, leave it. Lint will fail on an unused import, so this must be resolved either way.

- [ ] **Step 5: Verify types and lint**

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS.

- [ ] **Step 6: Verify the entry guard works**

Run: `npx tsx -e "const m = await import('./src/export-book-audio.ts'); console.log(typeof m.exportBookAudio)"`
Expected: prints `function` and exits immediately — no TTS calls, no ffmpeg, no OpenAI request.

- [ ] **Step 7: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/export-book-audio.ts
git commit -m "refactor(export-audio): extract exportBookAudio, accept an input arg, add entry guard

Lets PDF- and EPUB-sourced books produce an audiobook, which was previously
impossible since the out-dir could only be resolved from an ASIN."
```

---

### Task 6: `export-book-markdown.ts` — adopt the shared resolver

**Files:**
- Modify: `src/export-book-markdown.ts:433-456` (`main()` only)

**Interfaces:**
- Consumes: `resolveBookTarget` (Task 2)
- Produces: nothing new. `exportBookMarkdown()` at `:216` is already exported and is consumed unchanged.

This is the smallest task: the exported function already has the right shape, only its private arg resolver is redundant.

- [ ] **Step 1: Replace `main()`**

Replace the whole of `main()` (lines 433–456) with:

```ts
async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior of falling back to ASIN from .env.
  const target = await resolveBookTarget(process.argv[2] ?? getEnv('ASIN'))
  const pdfBasename =
    target.kind === 'pdf' || target.kind === 'epub' ? target.basename : undefined

  await exportBookMarkdown({ outDir: target.outDir, pdfBasename })
}
```

- [ ] **Step 2: Fix the imports**

Add `import { resolveBookTarget } from './book-input'` next to the other local imports. Then remove `resolveOutDir` and `sanitizeDirname` from the `./utils` import list — `main()` was their only consumer in this file.

Verify with: `grep -n "resolveOutDir\|sanitizeDirname" src/export-book-markdown.ts`
Expected: no matches.

- [ ] **Step 3: Verify types and lint**

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS.

- [ ] **Step 4: Run the existing markdown export tests**

Run: `npx vitest run src/__tests__/export-book-markdown.test.ts`
Expected: PASS, unchanged. This file tests the exported function directly, so it should be entirely unaffected — a failure here means Step 1 changed more than `main()`.

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: all pass, including `backfill-pdf-metadata.test.ts` (it imports `exportBookMarkdown`).

- [ ] **Step 6: Commit**

```bash
git add src/export-book-markdown.ts
git commit -m "refactor(export-markdown): use the shared book input resolver"
```

---

### Task 7: `transcribe-book-content.ts` — extract a callable step

**Files:**
- Modify: `src/transcribe-book-content.ts:544-616` (the head of `main()`) and `:906-920` (the tail + entry guard)

**Interfaces:**
- Consumes: `BookTarget`, `resolveBookTarget` (Task 2)
- Produces: `interface TranscribeOptions { useFileLogger?: boolean }`, `function transcribeBookContent(target: BookTarget, opts?: TranscribeOptions): Promise<void>`

**Critical detail:** this function has three separate `return` paths (the EPUB branch at `:583`, the "nothing to transcribe" early return at `:674`, and one inside the PDF branch). All of them stay — they become returns from `transcribeBookContent` instead of `main`.

**The logger call at `:616` becomes conditional.** The EPUB branch has its own `setupTimestampedLogger` call earlier in the function; that one must become conditional too.

- [ ] **Step 1: Change the signature and derive mode from the target**

Replace lines 544–548:

```ts
async function main() {
  const arg = process.argv[2]
  const isPdfMode = Boolean(arg && /\.pdf$/i.test(arg))
  const isEpubMode = Boolean(arg && /\.epub$/i.test(arg))
```

with:

```ts
export interface TranscribeOptions {
  // When true (default), hijacks console output to a timestamped log file in
  // `<outDir>/logs/`. `book.ts` passes false because it installs one shared
  // logger for the whole pipeline run.
  useFileLogger?: boolean
}

export async function transcribeBookContent(
  target: BookTarget,
  opts: TranscribeOptions = {}
): Promise<void> {
  const { useFileLogger = true } = opts
  const isPdfMode = target.kind === 'pdf'
  const isEpubMode = target.kind === 'epub'
```

- [ ] **Step 2: Replace the EPUB branch's path and out-dir derivation**

In the EPUB branch, replace:

```ts
    const epubPath = path.resolve(arg!)
    const base = sanitizeDirname(
      path.basename(epubPath, path.extname(epubPath))
    )
    const outDir = path.join('out', base)
    await fs.mkdir(outDir, { recursive: true })
    await setupTimestampedLogger(outDir)
```

with:

```ts
    const epubPath = target.kind === 'epub' ? target.sourcePath : ''
    const outDir = target.outDir
    await fs.mkdir(outDir, { recursive: true })
    if (useFileLogger) {
      await setupTimestampedLogger(outDir)
    }
```

- [ ] **Step 3: Replace the PDF/Kindle out-dir derivation**

Replace lines 586–616:

```ts
  const pdfPath = isPdfMode ? path.resolve(arg!) : undefined

  let outDir: string
  let pageScreenshotsDir: string | undefined
  let pageScreenshots: string[] = []

  if (pdfPath) {
    const base = sanitizeDirname(path.basename(pdfPath, path.extname(pdfPath)))
    outDir = path.join('out', base)
    await fs.mkdir(outDir, { recursive: true })
  } else {
    const asin = getEnv('ASIN')
    assert(asin, 'ASIN is required')

    outDir = await resolveOutDir(asin)
    pageScreenshotsDir = path.join(outDir, 'pages')
```

with:

```ts
  const pdfPath = target.kind === 'pdf' ? target.sourcePath : undefined

  const outDir = target.outDir
  let pageScreenshotsDir: string | undefined
  let pageScreenshots: string[] = []

  if (pdfPath) {
    await fs.mkdir(outDir, { recursive: true })
  } else {
    pageScreenshotsDir = path.join(outDir, 'pages')
```

Keep everything from `// fs.readdir over globby: …` through the `assert(pageScreenshots.length, …)` exactly as it is.

Then make the logger call at what was line 616 conditional:

```ts
  if (useFileLogger) {
    await setupTimestampedLogger(outDir)
  }
```

- [ ] **Step 4: Add the CLI wrapper and update the entry guard**

Replace lines 908–920 (the comment, `const entry`, and the guard block) with:

```ts
async function main() {
  // `?? getEnv('ASIN')` preserves this script's historical no-argument
  // behavior of falling back to ASIN from .env.
  const target = await resolveBookTarget(process.argv[2] ?? getEnv('ASIN'))
  await transcribeBookContent(target)
}

// Only auto-run when invoked directly (e.g. `pnpm tsx src/transcribe-book-content.ts`),
// so importing this module (e.g. from tests) doesn't kick off a transcription.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // Write to the real stderr (the console is redirected to the log file) and
    // exit non-zero so a `&&` pipeline stops before it reaches the export step.
    reportFatalError('Transcription failed', err)
    process.exit(1)
  }
}
```

- [ ] **Step 5: Fix the imports**

Add `import { resolveBookTarget } from './book-input'` and `import type { BookTarget } from './book-input'` (or one combined `import { resolveBookTarget, type BookTarget }`). Then check whether `resolveOutDir` and `sanitizeDirname` still have consumers in this file:

Run: `grep -n "resolveOutDir\|sanitizeDirname" src/transcribe-book-content.ts`

Remove from the `./utils` import list any that now have zero uses. `assert` and `getEnv` are used elsewhere in the file and stay.

- [ ] **Step 6: Verify types and lint**

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS.

- [ ] **Step 7: Verify the entry guard and the exported function**

Run: `npx tsx -e "const m = await import('./src/transcribe-book-content.ts'); console.log(typeof m.transcribeBookContent, typeof m.isRetryableError)"`
Expected: prints `function function` and exits immediately — no OpenAI calls. (`isRetryableError` is an existing export covered by `is-retryable-error.test.ts`; this confirms the module's other exports still resolve.)

- [ ] **Step 8: Run the full gate**

Run: `pnpm test`
Expected: all pass, including `is-retryable-error.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/transcribe-book-content.ts
git commit -m "refactor(transcribe): extract transcribeBookContent as a callable step"
```

---

### Task 8: `extract-kindle-book.ts` — extract a callable step that returns its final out-dir

**Files:**
- Modify: `src/extract-kindle-book.ts:50-68` (the head of `main()`) and `:1217-1228` (the unguarded call)

**Interfaces:**
- Consumes: nothing new
- Produces: `interface ExtractKindleBookOptions { asin: string; useFileLogger?: boolean }`, `function extractKindleBook(opts: ExtractKindleBookOptions): Promise<{ outDir: string }>`

**The critical detail in this whole plan:** `extract-kindle-book.ts:645-670` renames `out/<asin>` to `out/<asin>-<sanitizeDirname(title)>` once the book title is known, reassigning its local `outDir`. The directory resolved *before* extraction is stale afterward. `extractKindleBook` must **return its final `outDir`** so `runBook` can thread it into the downstream steps. Get this wrong and a first-ever Kindle export transcribes into `out/<asin>` while the screenshots sit in `out/<asin>-<title>`.

**Also critical:** this file calls `await main()` unguarded at `:1217`. Importing it from `book.ts` would launch Playwright and start a full extraction at import time.

- [ ] **Step 1: Change the signature**

Replace lines 50–57:

```ts
async function main() {
  const asin = getEnv('ASIN')
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  const force = getEnv('FORCE') === 'true'
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')
```

with:

```ts
export interface ExtractKindleBookOptions {
  asin: string
  // When true (default), hijacks console output to a timestamped log file in
  // `<outDir>/logs/`. `book.ts` passes false because it installs one shared
  // logger for the whole pipeline run.
  useFileLogger?: boolean
}

/**
 * Extract a Kindle book's page screenshots and metadata.
 *
 * Returns the FINAL output directory. Extraction renames `out/<asin>` to
 * `out/<asin>-<title>` once the title is known (see the rename below), so the
 * directory a caller resolved beforehand is stale on return.
 */
export async function extractKindleBook(
  opts: ExtractKindleBookOptions
): Promise<{ outDir: string }> {
  const { asin, useFileLogger = true } = opts
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  const force = getEnv('FORCE') === 'true'
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')
```

- [ ] **Step 2: Make the logger call conditional**

Replace line 68:

```ts
  await setupTimestampedLogger(outDir)
```

with:

```ts
  if (useFileLogger) {
    await setupTimestampedLogger(outDir)
  }
```

- [ ] **Step 3: Return the final out-dir from all three exit paths**

There are exactly **three** exit points to change, and several bare `return`s that must be **left alone**.

**Change these three:**

1. Line **186**, the early return after `'✅ Extraction appears complete based on page range. Use FORCE=true to re-extract.'` — change `return` to `return { outDir }`
2. Line **205**, the early return after `` `${colors.green}✅ Extraction appears complete. Use FORCE=true to re-extract.${colors.reset}` `` — change `return` to `return { outDir }`
3. The **end of the function** (currently line ~1170, after `await context.close()`) — add a new final statement:

```ts
  await page.close()
  await context.close()

  return { outDir }
}
```

**Do NOT change** the bare `return`s at lines **293**, **309**, **364**, **393**, and **548**. Those are inside nested scopes — the `page.on('response', …)` handler, the `recoverBookMetadata()` inner function, and an alert-dismissal helper — and returning `{ outDir }` from them would be wrong (and a type error where the enclosing function is typed `Promise<void>`).

Verify you changed the right ones:

Run: `grep -n "return { outDir }" src/extract-kindle-book.ts`
Expected: exactly 3 matches.

Because `outDir` is declared `let` at `:67` and reassigned at `:666` during the title rename, `return { outDir }` always yields whatever the directory is at that moment — which is exactly the required behavior.

- [ ] **Step 4: Add the CLI wrapper and entry guard**

Replace lines 1217–1228:

```ts
try {
  await main()
} catch (err) {
  // reportFatalError writes to the real stderr (not the redirected console),
  // …
  reportFatalError('Extraction failed', err)
  process.exit(1)
}
```

with:

```ts
async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')
  await extractKindleBook({ asin })
}

// Only auto-run when invoked directly, so importing this module (from book.ts)
// doesn't launch Playwright and start an extraction at import time.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    // reportFatalError writes to the real stderr (not the redirected console),
    // so the reason is visible on the terminal. Force a non-zero exit so a
    // `pnpm tsx … && pnpm tsx …` chain stops here instead of running
    // transcription against a missing/partial extraction — process.exit also
    // tears down any still-open Playwright browser that would otherwise keep
    // the event loop alive and hang the whole command chain.
    reportFatalError('Extraction failed', err)
    process.exit(1)
  }
}
```

- [ ] **Step 5: Add the `pathToFileURL` import**

Add to the `node:` imports at the top of the file:

```ts
import { pathToFileURL } from 'node:url'
```

- [ ] **Step 6: Verify types and lint**

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS. A "not all code paths return a value" error means Step 3 missed a `return`.

- [ ] **Step 7: Verify the entry guard — this is the highest-risk check in the plan**

Run: `npx tsx -e "const m = await import('./src/extract-kindle-book.ts'); console.log(typeof m.extractKindleBook)"`
Expected: prints `function` and **exits within a second or two**. If it hangs, opens a browser window, or prints Amazon login output, the entry guard is not working — stop and fix it before continuing.

- [ ] **Step 8: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/extract-kindle-book.ts
git commit -m "refactor(extract): extract extractKindleBook returning its final outDir

Extraction renames out/<asin> to out/<asin>-<title> once the title is known,
so callers need the post-rename directory. Also adds the entry guard the
module was missing."
```

---

### Task 9: `runBook` — the orchestration sequence

**Files:**
- Create: `src/book.ts` (the `runBook` half; the CLI half lands in Task 10)
- Test: `src/__tests__/run-book.test.ts`

**Interfaces:**
- Consumes: `BookFlags` (Task 1), `BookTarget` (Task 2); the step signatures from Tasks 4–8
- Produces:
  - `class BookStepError extends Error` with `readonly label: string` and `readonly cause: unknown`
  - `interface BookSteps { … }` (exact shape below)
  - `function runBook(target: BookTarget, flags: BookFlags, steps: BookSteps): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/run-book.test.ts`:

```ts
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
    expect(recorded.calls).toEqual(['extract', 'transcribe', 'markdown'])
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

    await expect(
      runBook(KINDLE_TARGET, NO_FLAGS, steps)
    ).rejects.toMatchObject({ label: 'Extraction failed' })
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/run-book.test.ts`
Expected: FAIL — `Failed to resolve import "../book"`.

- [ ] **Step 3: Write `runBook`**

Create `src/book.ts` with only the orchestration half for now:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/run-book.test.ts`
Expected: PASS, 17 tests.

If `rejects.toSatisfy` is unavailable in this Vitest version, replace that one assertion with:

```ts
    await expect(runBook(PDF_TARGET, NO_FLAGS, steps)).rejects.toMatchObject({
      cause: original
    })
```

- [ ] **Step 5: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/book.ts src/__tests__/run-book.test.ts
git commit -m "feat(book): add runBook orchestration with injected steps"
```

---

### Task 10: `book.ts` CLI — wire preflight, logging, and error reporting

**Files:**
- Modify: `src/book.ts` (append the CLI half)
- Modify: `package.json` (add the `book` script)

**Interfaces:**
- Consumes: everything from Tasks 1–9
- Produces: the `pnpm book` command. No new exports.

**Why the default steps use dynamic `import()`:** `extract-kindle-book.ts` pulls in Playwright and `export-book-audio.ts` pulls in `fluent-ffmpeg` + `unrealspeech-api`. Loading those eagerly would tax every run, including a plain PDF-to-markdown one that touches neither.

- [ ] **Step 1: Replace the import block at the top of `src/book.ts`**

Task 9 left this file with three type-only imports. Replace that block entirely with the following — it is the complete set for the finished file, and it supersedes (does not append to) what Task 9 wrote:

```ts
import 'dotenv/config'

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { parseBookFlags } from './book-flags'
import type { BookFlags } from './book-flags'
import { resolveBookTarget } from './book-input'
import type { BookTarget } from './book-input'
import { checkPreflight } from './book-preflight'
import type { PreflightProbes, SourceFileProbe } from './book-preflight'
import type { ExportBookMarkdownOptions } from './export-book-markdown'
import { fileExists, reportFatalError, setupTimestampedLogger } from './utils'
```

Note `'dotenv/config'` must be first — every other pipeline script starts with it, and preflight reads `process.env`.

- [ ] **Step 2: Append the default steps**

```ts
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
    (await import('./export-book-audio')).exportBookAudio(opts)
}
```

- [ ] **Step 3: Append the probes**

```ts
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
```

- [ ] **Step 4: Append `main()` and the entry guard**

```ts
async function main() {
  const [input, ...flagArgs] = process.argv.slice(2)

  // Flags parse first so `pnpm book --pfd x.pdf` reports the typo rather than
  // trying to classify "--pfd" as an input.
  const flags = parseBookFlags(flagArgs)
  const target = await resolveBookTarget(input)

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
    reportFatalError(
      'Preflight failed',
      problems.map((p) => `\n  - ${p}`).join('')
    )
    process.exit(1)
  }

  // One shared log file for the whole run. Without this each step installs its
  // own and a single export scatters output across several files.
  await fs.mkdir(target.outDir, { recursive: true })
  const { logPath } = await setupTimestampedLogger(target.outDir)

  await runBook(target, flags, defaultBookSteps)

  // console.* is redirected to the log file at this point, so write the
  // summary to the real stdout.
  process.stdout.write(`\n✅ Done. Log: ${logPath}\n`)
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
```

- [ ] **Step 5: Add the npm script**

In `package.json`, add `"book": "tsx src/book.ts"` to `scripts`, placed above `"test"`:

```json
  "scripts": {
    "book": "tsx src/book.ts",
    "test": "run-s test:*",
```

- [ ] **Step 6: Verify types and lint**

Run: `pnpm test:typecheck && pnpm test:lint`
Expected: PASS.

- [ ] **Step 7: Verify the usage error**

Run: `pnpm book`
Expected: exits non-zero, printing `❌ an input is required` followed by the usage block listing `--pdf`, `--audio`, `--all`, `--force`.

- [ ] **Step 8: Verify unknown-flag rejection**

Run: `pnpm book out/does-not-exist --pfd`
Expected: exits non-zero with `Unknown flag: --pfd`. The flag error must appear *before* any complaint about the missing directory, proving flags parse first.

- [ ] **Step 9: Verify preflight on a missing source file**

Run: `pnpm book /tmp/definitely-not-here.pdf`
Expected: exits non-zero with `❌ Preflight failed:` and a bullet reading `source file not found: /tmp/definitely-not-here.pdf`. No `out/` directory is created and no log file is written.

- [ ] **Step 10: Verify preflight on an empty out-dir**

```bash
mkdir -p out/preflight-check-tmp
pnpm book out/preflight-check-tmp
```

Expected: exits non-zero with a bullet reading `no content.json in … ; nothing to export`.

Then clean up: `rmdir out/preflight-check-tmp`

- [ ] **Step 11: Run the full gate**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/book.ts package.json
git commit -m "feat(book): add the pnpm book CLI entry point"
```

---

### Task 11: End-to-end verification against a real book

**Files:** none modified — this task is verification only.

**Why a separate task:** Tasks 1–10 are unit-tested but nothing has yet proved the wired pipeline produces a real `book.md`. The step functions were extracted from working code, so the risk is in the seams (out-dir threading, the shared logger, the entry guards), which only a real run exercises.

**Prerequisite:** an existing transcribed book in `out/`. Find one with:

```bash
ls -d out/*/ | head -20
for d in out/*/; do [ -f "$d/content.json" ] && echo "$d"; done | head -5
```

If none exists, skip Steps 2–4 and note that in the commit message; Steps 5–6 still apply.

- [ ] **Step 1: Confirm the re-export path on an existing book**

Pick a directory from the prerequisite that contains `content.json`, then:

```bash
pnpm book out/<dir>
```

Expected: exits 0, prints `✅ Done. Log: out/<dir>/logs/<timestamp>.log`, and rewrites `out/<dir>/book.md`.

- [ ] **Step 2: Confirm exactly one log file was created**

```bash
ls -t out/<dir>/logs | head -3
```

Expected: the newest entry is the run you just did, and only **one** new file appeared. Two or more new files means a step installed its own logger — check that `useFileLogger: false` is reaching it.

- [ ] **Step 3: Confirm the markdown is non-trivial**

```bash
wc -l out/<dir>/book.md
head -20 out/<dir>/book.md
```

Expected: hundreds or thousands of lines, opening with a title heading. A near-empty file means the export ran against the wrong `outDir`.

- [ ] **Step 4: Compare against the old two-command path**

```bash
cp out/<dir>/book.md /tmp/book-via-pnpm-book.md
pnpm tsx src/export-book-markdown.ts out/<dir>
diff /tmp/book-via-pnpm-book.md out/<dir>/book.md && echo "IDENTICAL"
```

Expected: `IDENTICAL`. The orchestrator must produce byte-identical output to the standalone script — this is the core regression check for the whole refactor.

- [ ] **Step 5: Confirm each standalone script still runs**

```bash
pnpm tsx src/export-book-markdown.ts out/<dir> && echo "markdown OK"
pnpm tsx src/export-book-pdf.ts out/<dir> && echo "pdf OK"
```

Expected: both succeed. (`export-book-pdf.ts` needs `metadata.json` with a non-empty `toc`; if the chosen book has none, it fails with `invalid book metadata: missing toc` — that is pre-existing behavior, not a regression. Pick a different book or note it.)

- [ ] **Step 6: Confirm the PDF flag path**

```bash
pnpm book out/<dir> --pdf
ls -la out/<dir>/book.pdf
```

Expected: exits 0 and `book.pdf` has a recent mtime. If the book has no `toc`, expect a clean `❌ PDF export failed: … missing toc` with `book.md` still freshly written — which is the intended fail-fast ordering.

- [ ] **Step 7: Commit nothing, report findings**

This task produces no code changes. Report which steps passed and any that were skipped for lack of a suitable book.

---

### Task 12: Document the new workflow

**Files:**
- Modify: `CLAUDE.md` (the "Core Scripts", "PDF Transcription", and "EPUB Transcription" sections)

- [ ] **Step 1: Add a new section immediately after "### Setup"**

```markdown
### One-Command Export (Preferred)

```bash
pnpm book <input> [--pdf] [--audio] [--all] [--force]
```

`<input>` is a `.pdf` path, an `.epub` path, a Kindle ASIN, or an existing
`out/<dir>`. The command detects which, then runs the whole pipeline in one
process — extract (Kindle only) → transcribe → export — writing a **single**
timestamped log file to `out/<dir>/logs/`.

```bash
pnpm book ~/Books/example.pdf            # → out/example/book.md
pnpm book ~/Books/example.epub --pdf     # → book.md + book.pdf
pnpm book B0819W19WD --all               # extract, transcribe, md + pdf + audio
pnpm book out/B0819W19WD                 # re-export only; skips extract+transcribe
```

Markdown always runs; `--pdf` and `--audio` are additive and `--all` is both.
Passing an ASIN as the argument means Kindle books no longer require editing
`ASIN` in `.env`.

Preflight runs before any step, so a missing `OPENAI_API_KEY`, an absent
`ffmpeg`, or an unreadable source file fails immediately rather than after a
long transcription. Steps run cheapest-first, so a `--pdf` failure still
leaves `book.md` on disk.

The per-step scripts below all still work unchanged, and remain the way to run
one stage in isolation.
```

- [ ] **Step 2: Note the new audio capability**

In the "Core Scripts" section, append to the `export-book-audio.ts` line:

```markdown
# 3. (Optional) Export formats
pnpm tsx src/export-book-pdf.ts       # Generate PDF
pnpm tsx src/export-book-markdown.ts  # Generate Markdown
pnpm tsx src/export-book-audio.ts     # Generate AI audiobook
                                      # (also accepts a .pdf/.epub path or out/<dir>,
                                      #  so PDF- and EPUB-sourced books can now
                                      #  produce audiobooks too)
```

- [ ] **Step 3: Document the new modules**

In the "Key Modules" section, after the `pdf-drop-cap.ts` bullet group, add:

```markdown
- **Single-command pipeline modules** (see "One-Command Export" above):
  - `book-flags.ts` - pure `parseBookFlags()`: `--pdf` / `--audio` / `--all` / `--force`
  - `book-input.ts` - pure `classifyBookArg()` + `resolveBookTarget()`: maps a
    CLI input (PDF path, EPUB path, ASIN, `out/` dir) to a `BookTarget` with its
    output directory. **The single source of truth** — the transcribe and export
    scripts all resolve their argument through it.
  - `book-preflight.ts` - pure `checkPreflight()`: unmet requirements (TTS
    credentials, ffmpeg, Amazon credentials, source file readability) reported
    *before* any long-running step
  - `book.ts` - `runBook()` orchestration over injectable steps, plus the
    `pnpm book` CLI. Note `extractKindleBook()` returns its **final** out-dir,
    because extraction renames `out/<asin>` to `out/<asin>-<title>`.
```

- [ ] **Step 4: Verify the docs match reality**

Run each command block in the new section against `--help`-less reality:

```bash
pnpm book 2>&1 | head -20
```

Expected: the usage text printed matches the flags documented in Step 1. If they disagree, fix the doc, not the code (the code is already tested).

- [ ] **Step 5: Check the PII hook will accept the commit**

Run: `git add CLAUDE.md && git diff --cached | grep -nE "B0[A-Z0-9]{8}"`
Expected: the only match is `B0819W19WD`, the documented public sample. Any other `B0…` ASIN or a real book title will be rejected by `.githooks/pre-commit`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the pnpm book single-command workflow"
```

---

## Verification Checklist

After all tasks, confirm:

- [ ] `pnpm test` passes (format, lint, typecheck, unit)
- [ ] `pnpm book` with no argument prints usage and exits non-zero
- [ ] `pnpm book out/<transcribed-book>` produces a `book.md` byte-identical to the standalone script's output
- [ ] Exactly one log file per `pnpm book` run
- [ ] All five standalone scripts still run from the CLI
- [ ] Importing any of the five step modules runs nothing (all entry guards work)
- [ ] `backfill-pdf-metadata.ts` still works — it imports `exportBookMarkdown`
