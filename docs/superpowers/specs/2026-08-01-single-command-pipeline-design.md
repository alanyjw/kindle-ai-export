# Single-command pipeline (`pnpm book`) — design

**Date:** 2026-08-01
**Status:** Ready for implementation plan.
**Scope:** Add one orchestrator entry point that runs the whole transcribe → export pipeline for any input format, and make each existing pipeline step callable as a function.

---

## Problem

Exporting a book takes two or three commands, each repeating the same long input path or depending on the same env var:

```bash
# PDF / EPUB
pnpm tsx src/transcribe-book-content.ts /path/to/book.pdf
pnpm tsx src/export-book-markdown.ts /path/to/book.pdf

# Kindle
pnpm tsx src/extract-kindle-book.ts
pnpm tsx src/transcribe-book-content.ts
pnpm tsx src/export-book-markdown.ts
```

Four specific frictions:

1. **The input path is typed twice** for PDF/EPUB, and it is usually a long, space-containing path that needs shell escaping.
2. **The Kindle path has no input argument at all** — all three steps read `ASIN` from `.env` (`extract-kindle-book.ts:50`, `transcribe-book-content.ts:544`, `export-book-audio.ts:27`), so switching books means editing `.env` first.
3. **`package.json` has no pipeline scripts** — only `test:*` — so every invocation is a full `pnpm tsx src/<file>.ts`.
4. **Each step installs its own file logger** (`setupTimestampedLogger`, `utils.ts:181`), so one book export produces two or three separate timestamped log files with no single chronological record.

The arg-resolution logic is also duplicated three times, and has already drifted:

| Location | Handles |
|---|---|
| `transcribe-book-content.ts:545` | `.pdf`, `.epub`, else `ASIN` env |
| `export-book-markdown.ts:433` | `.pdf`/`.epub`, an `out/` dir, else `ASIN` env |
| `export-book-pdf.ts:17` | `.pdf`/`.epub`, an `out/` dir, else `ASIN` env |

Only the two exporters accept a bare `out/<dir>`; transcribe does not.

## Goals

- One command per book: `pnpm book <input>`, for PDF, EPUB, Kindle ASIN, or an existing `out/` directory.
- Pass an **ASIN as an argument** so Kindle books no longer require editing `.env`.
- **One log file per run**, covering every step in order.
- Collapse the three duplicated arg resolvers into one tested module.
- Every existing script keeps working standalone, unchanged, exactly as documented in `CLAUDE.md`.

## Non-goals

- Batch mode / multiple inputs per invocation. `backfill-pdf-metadata.ts` already owns bulk work over `out/`, and shell globbing covers the rest: `for f in ~/Downloads/*.pdf; do pnpm book "$f"; done`.
- Watch mode.
- A `--no-md` flag. Markdown always runs.
- Unifying the per-step progress bars. Each step keeps its own.
- Any change to transcription, OCR, heading recovery, or export rendering behavior.

---

## Command surface

```
pnpm book <input> [flags]

  <input>
    book.pdf        transcribe from PDF, then export
    book.epub       transcribe from EPUB, then export
    B0819W19WD      Kindle ASIN — extract, transcribe, then export
    out/<dir>       skip extract + transcribe; re-export from existing content.json

  flags
    --pdf      also export book.pdf
    --audio    also export the audiobook
    --all      equivalent to --pdf --audio
    --force    re-run steps that would otherwise no-op (propagates as FORCE=true)
```

Markdown always runs; `--pdf` and `--audio` are additive.

`<input>` is required. Unlike the current scripts, `pnpm book` with no argument does **not** silently fall back to `ASIN` from `.env` — it errors with usage text. The env fallback stays available through the standalone scripts, which are unchanged. Rationale: the whole point of the ASIN argument is to stop `.env` from being hidden state, and a silent fallback reintroduces "which book did that just export?" ambiguity.

Note on flag forwarding: `pnpm book x --pdf` forwards trailing flags to the script. `pnpm book -- x --pdf` is the explicit form if forwarding ever misbehaves; both are documented in `CLAUDE.md`.

---

## Architecture

```
src/book.ts                  new — orchestrator entry point
src/book-input.ts            new — pure input classification + target resolution
src/book-flags.ts            new — pure flag parsing
src/book-preflight.ts        new — pure requirement checking
```

Step functions extracted from the existing scripts, each keeping its `main()` and CLI entry guard:

```
extractKindleBook()      ← extract-kindle-book.ts
transcribeBookContent()  ← transcribe-book-content.ts
exportBookMarkdown()     ← export-book-markdown.ts   (already exists, :216)
exportBookPdf()          ← export-book-pdf.ts
exportBookAudio()        ← export-book-audio.ts
```

### Execution flow

```
resolve target ─┬─ kindle → extractKindleBook ─┐
                ├─ pdf ────────────────────────┤
                ├─ epub ───────────────────────┼→ transcribeBookContent → exportBookMarkdown
                └─ outdir → (skip both) ───────┘        → [exportBookPdf] → [exportBookAudio]
```

Step order is deliberately cheapest-and-most-likely-to-succeed first. If `--pdf` fails on its `metadata.toc` assertion (`export-book-pdf.ts` asserts a non-empty `toc`), the markdown is already written to disk.

### `src/book-input.ts`

```ts
export type BookArg =
  | { kind: 'pdf'; sourcePath: string; basename: string }
  | { kind: 'epub'; sourcePath: string; basename: string }
  | { kind: 'kindle'; asin: string }
  | { kind: 'outdir'; outDir: string }

export type BookTarget = BookArg & { outDir: string }

// Pure apart from one `statSync`-equivalent existence probe, which is
// injected so the function stays unit-testable. Throws on an empty/absent arg.
export function classifyBookArg(
  arg: string | undefined,
  isExistingDir: (p: string) => boolean
): BookArg

// Async only for the `kindle` case, which needs resolveOutDir()'s
// `<asin>` vs `<asin>-<title>` directory scan (utils.ts:80).
export async function resolveBookTarget(arg: string | undefined): Promise<BookTarget>
```

Classification rules, in order:

1. `/\.pdf$/i` → `pdf`; `outDir = out/<sanitizeDirname(basename)>`
2. `/\.epub$/i` → `epub`; same `outDir` derivation
3. contains a path separator, **or** names an existing directory → `outdir`
4. otherwise → `kindle`, treating the arg as an ASIN; `outDir = await resolveOutDir(asin)`

Rule 3 before rule 4 matters: an ASIN is an opaque alphanumeric string, so shape alone cannot distinguish it from a bare directory name. A path separator is the reliable discriminator (`out/ASIN000001` has one, an ASIN never does), with on-disk existence as the fallback for a bare directory name.

### Preserving the `ASIN` env fallback

`resolveBookTarget()` throws when `arg` is absent, but the standalone scripts must keep their current no-argument behavior of reading `ASIN` from `.env`. They do this at the call site:

```ts
// standalone main() in transcribe / export-markdown / export-pdf / export-audio
const target = await resolveBookTarget(process.argv[2] ?? getEnv('ASIN'))
```

`book.ts` deliberately does **not** apply that fallback — see "Command surface" above. So the strictness lives in the orchestrator, and the env fallback lives in the four `main()` functions, unchanged in observable behavior.

`transcribe-book-content.ts`, `export-book-markdown.ts`, and `export-book-pdf.ts` replace their private resolvers with this one. That produces exactly one behavior change to an existing script: **transcribe gains `out/<dir>` support** it did not have. It is additive — no previously working invocation changes meaning.

### `src/book-flags.ts`

```ts
export interface BookFlags {
  pdf: boolean
  audio: boolean
  force: boolean
}

// Pure. Throws on an unrecognized flag.
export function parseBookFlags(argv: readonly string[]): BookFlags
```

`--all` sets both `pdf` and `audio`. Unknown flags are a hard error rather than being ignored, so `--pfd` fails loudly instead of silently skipping the PDF export.

### `src/book-preflight.ts`

Audio runs **last**, after a transcription that can take many minutes. A missing `OPENAI_API_KEY` or an absent `ffmpeg` must not be discovered at the end of that.

```ts
export interface PreflightEnv {
  TTS_ENGINE?: string
  OPENAI_API_KEY?: string
  UNREAL_SPEECH_API_KEY?: string
  AMAZON_EMAIL?: string
  AMAZON_PASSWORD?: string
}

// Pure. Returns human-readable descriptions of unmet requirements.
export function checkPreflight(
  target: BookTarget,
  flags: BookFlags,
  env: PreflightEnv,
  probes: { hasFfmpeg: boolean; sourceFile?: 'ok' | 'missing' | 'unreadable' }
): string[]
```

Requirements:

| Condition | Requirement |
|---|---|
| `--audio` | `OPENAI_API_KEY` when `TTS_ENGINE` is unset or `openai`; `UNREAL_SPEECH_API_KEY` when `TTS_ENGINE=unrealspeech` (default resolution matches `export-book-audio.ts:66`) |
| `--audio` | `ffmpeg` resolvable on `PATH` |
| `kind === 'kindle'` | `AMAZON_EMAIL` and `AMAZON_PASSWORD` |
| `kind === 'pdf' \| 'epub'` | source file exists and passes an `R_OK` access check |
| `kind === 'outdir'` | `content.json` exists in the directory |

`book.ts` performs the two I/O probes (`PATH` lookup for `ffmpeg`, `fs.access(sourcePath, R_OK)`) and passes the results in, keeping `checkPreflight` pure and directly testable.

The source-file probe distinguishes **missing** from **unreadable**. `backfill-pdf-metadata.ts` already carries this distinction (`'skipped: source PDF not found'` vs `'skipped: source PDF unreadable'`) because on macOS, files under iCloud Drive exist but fail a read check with `EPERM` until the terminal is granted Full Disk Access. The unreadable message repeats that hint.

If `checkPreflight` returns a non-empty list, `book.ts` prints every unmet requirement and exits 1 without running any step.

### `src/book.ts`

```ts
export interface BookSteps {
  extractKindleBook: (opts: { asin: string; useFileLogger: boolean }) => Promise<unknown>
  transcribeBookContent: (target: BookTarget, opts: { useFileLogger: boolean }) => Promise<unknown>
  exportBookMarkdown: (opts: ExportBookMarkdownOptions) => Promise<unknown>
  exportBookPdf: (opts: { outDir: string; useFileLogger: boolean }) => Promise<unknown>
  exportBookAudio: (opts: { outDir: string; useFileLogger: boolean }) => Promise<unknown>
}

export async function runBook(
  target: BookTarget,
  flags: BookFlags,
  steps: BookSteps
): Promise<void>
```

`runBook` takes its steps as an injected dependency, so the orchestration sequence is testable without touching a browser, the OpenAI API, or the filesystem. This matches the pattern already used by `recover-book-metadata.ts` (injectable fetcher), `title-page-meta.ts` (injectable extractor + image loader), and `pdf-metadata.ts` (injectable PDF source).

### Logging

`book.ts` calls `setupTimestampedLogger(outDir)` **exactly once**, immediately after resolving the target, then passes `useFileLogger: false` to every step. Without this, each step installs its own logger and a single run scatters output across three to five files in `out/<dir>/logs/`.

`exportBookMarkdown` already exposes this option (`export-book-markdown.ts:200-207`); the other four step functions gain the same option with the same default (`true`, preserving standalone behavior).

The 2FA prompt in `extract-kindle-book.ts:449` uses `@inquirer/prompts`, which writes to stdout directly rather than through `console.*`, so it remains visible under the shared file logger. No change needed.

---

## Refactors to existing scripts

Each script keeps its `main()` and its CLI behavior. Two of them are missing the entry guard that `transcribe-book-content.ts:910` and `export-book-markdown.ts:458` already have, and gain it — otherwise importing them from `book.ts` would execute a full export at import time.

| File | Change |
|---|---|
| `export-book-markdown.ts` | none — `exportBookMarkdown()` (`:216`) is consumed as-is |
| `transcribe-book-content.ts` | export `transcribeBookContent(target, opts)`; `main()` becomes arg-parsing + a call to it |
| `export-book-pdf.ts` | extract `exportBookPdf({ outDir, useFileLogger })`; **add entry guard** (currently `await main()` unguarded at `:133`) |
| `export-book-audio.ts` | extract `exportBookAudio({ outDir, useFileLogger })`; **add entry guard** (currently `await main()` unguarded at `:397`) |
| `extract-kindle-book.ts` | export `extractKindleBook({ asin, force })`; `main()` becomes env-reading + a call to it |
| `package.json` | add `"book": "tsx src/book.ts"` |

### Side effect: audiobooks for PDF and EPUB books

`export-book-audio.ts:27` reads `ASIN` from env and accepts no CLI argument, so **PDF- and EPUB-sourced books currently cannot produce an audiobook at all** — there is no ASIN to resolve. Giving `exportBookAudio()` an explicit `outDir` fixes this. `pnpm book book.pdf --audio` is new capability, not merely a shortcut.

The standalone `export-book-audio.ts` also gains the same `<input>` argument the other exporters accept, resolved through `resolveBookTarget()`, so the fix is available outside the orchestrator too.

---

## Error handling

Fail fast. Each step function throws; `runBook` lets the error propagate after tagging which step produced it; `book.ts`'s top-level catch calls `reportFatalError(label, err)` and `process.exit(1)`.

`reportFatalError` (`utils.ts`) writes synchronously to the real fd 2, bypassing the console redirect and surviving `process.exit()` — this is why a failure is still visible even though the shared file logger has captured `console.*`.

Step labels stay byte-identical to what the standalone scripts print today, so existing log-grepping habits carry over:

- `Extraction failed`
- `Transcription failed`
- `Markdown export failed`
- `PDF export failed`
- `Audio export failed`

Exit codes: `0` on success, `1` on any failure or unmet preflight requirement.

`verifyBookContent` findings stay **non-fatal warnings**, exactly as they are today inside transcribe — they are reported and the pipeline continues.

### Idempotency

Every step is already idempotent, so re-running `pnpm book` on a finished book is cheap and safe:

- `extract-kindle-book.ts` detects a complete extraction and early-returns unless `FORCE=true`
- `transcribe-book-content.ts` loads existing `content.json` and skips already-processed screenshots, printing `Nothing to transcribe` when up to date
- `export-book-audio.ts` hashes TTS settings to avoid regenerating unchanged audio

`--force` is implemented by setting `process.env.FORCE = 'true'` in `book.ts` before any step runs. The existing `getEnv('FORCE')` checks — at `extract-kindle-book.ts:54`, inside transcribe, and inside `export-book-audio.ts` — then see it unchanged, with no new parameter threaded through five call sites.

For the same reason, `force` and `preview` are **not** parameters on the extracted step functions. Both already resolve from env inside the current `main()` bodies (`FORCE`, `AUDIOBOOK_PREVIEW`), and that resolution moves into the step function unchanged. `useFileLogger` is the only new option each one gains, because it is the only behavior the orchestrator genuinely needs to override.

`AUDIOBOOK_PREVIEW=true pnpm book <input> --audio` therefore still produces a preview audiobook. No `--preview` flag is added.

---

## Testing

Three pure units plus `runBook`, tested directly with Vitest in `src/__tests__/`:

**`classifyBookArg`** (with a stubbed `isExistingDir`)
- `.pdf`, `.PDF`, `.epub`, `.EPUB` → correct kind and sanitized basename
- a path with spaces → basename sanitized via `sanitizeDirname`
- `out/ASIN000001` → `outdir` (path separator)
- a bare directory name that exists → `outdir`
- a bare alphanumeric string that is not an existing directory → `kindle`
- `undefined` and `''` → throws with usage text

**`parseBookFlags`**
- defaults are all `false`
- `--all` sets `pdf` and `audio`
- `--pdf --audio` equals `--all`
- flag order does not matter
- an unknown flag throws

**`checkPreflight`**
- each requirement failing in isolation returns exactly one description
- `--audio` with `TTS_ENGINE=unrealspeech` demands `UNREAL_SPEECH_API_KEY`, not `OPENAI_API_KEY`
- `--audio` with `TTS_ENGINE` unset demands `OPENAI_API_KEY`
- a satisfied configuration returns `[]`
- `sourceFile: 'unreadable'` produces a message distinct from `'missing'`, mentioning Full Disk Access

**`runBook`** with injected fake steps recording their call order:
- `kindle` target → `extractKindleBook` runs first
- `pdf` and `epub` targets → `extractKindleBook` never called
- `outdir` target → neither `extractKindleBook` nor `transcribeBookContent` called
- no flags → markdown only
- `--pdf` → markdown then PDF, in that order
- `--all` → markdown, PDF, audio, in that order
- a throwing `transcribeBookContent` → no exporter is called and the error propagates
- every step receives `useFileLogger: false`

The five refactored scripts get no new tests. Their behavior is unchanged and the existing suite covers them; `pnpm test` (format, lint, typecheck, unit) must stay green.

### Privacy constraint on fixtures

Test fixtures use `ASIN000001` and `"Example Book"` / `"Author Name"`. The `.githooks` pre-commit scanner rejects real book titles (derived at runtime from the local `out/` library), `B0`-prefixed ASINs, and PII. The documented public sample `B0819W19WD` is the sole permitted real ASIN.

---

## Files touched

**New**

- `src/book.ts`
- `src/book-input.ts`
- `src/book-flags.ts`
- `src/book-preflight.ts`
- `src/__tests__/book-input.test.ts`
- `src/__tests__/book-flags.test.ts`
- `src/__tests__/book-preflight.test.ts`
- `src/__tests__/run-book.test.ts`

**Modified**

- `src/transcribe-book-content.ts` — export step function, use `resolveBookTarget`
- `src/export-book-markdown.ts` — use `resolveBookTarget`
- `src/export-book-pdf.ts` — export step function, add entry guard, use `resolveBookTarget`
- `src/export-book-audio.ts` — export step function, add entry guard, accept an input argument
- `src/extract-kindle-book.ts` — export step function
- `package.json` — add the `book` script
- `CLAUDE.md` — document `pnpm book` as the primary workflow, keep the per-step commands documented below it

---

## Known limitations (intended)

- **ASIN vs. bare directory-name ambiguity.** A separator-free arg that names no existing directory is treated as an ASIN, so a typo'd bare directory name becomes an attempted Kindle extraction rather than an error. A typo'd `out/…` path is unaffected — it still classifies as `outdir` and fails preflight on the missing `content.json`. For the bare case, preflight fails immediately for anyone without Amazon credentials configured, and the error names the resolved ASIN.
- **No cross-step progress unification.** Three progress bars still appear in sequence for a `--all` run.
- **`--force` is process-global.** It sets `FORCE=true` for every step, not per-step. Forcing only a re-export while keeping an existing transcription still means invoking the exporter script directly.
