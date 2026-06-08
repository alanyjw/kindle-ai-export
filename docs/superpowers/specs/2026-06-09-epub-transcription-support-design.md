# EPUB transcription support — design

**Date:** 2026-06-09
**Status:** Approved, ready for implementation plan
**Scope:** Add EPUB as a third input format to the transcribe pipeline, alongside Kindle screenshots and PDF.

---

## Problem

`src/transcribe-book-content.ts` has exactly two input modes, branched on the CLI arg:

- **PDF mode** — `transcribe-book-content.ts:415`: `isPdfMode = /\.pdf$/i.test(arg)`. Renders pages via `pdfjs-dist`, prefers embedded text, falls back to OpenAI vision OCR.
- **Kindle screenshot mode** (the `else` branch) — requires `ASIN` env + pre-extracted PNGs in `out/${asin}/pages/`, OCRs every page.

An `.epub` passed today falls through to the screenshot branch (it is not `.pdf`) and fails at `assert(asin, 'ASIN is required')` or the "no page screenshots found" assert.

EPUB is fundamentally different from both existing inputs: it is a zip of XHTML/CSS that **already contains clean, structured text and a real table of contents**. OCR/vision is unnecessary and would *reduce* fidelity. This design adds a dedicated EPUB branch that parses the container directly and produces the same `content.json` + `metadata.json` artifacts the downstream exporters already consume.

## Goals

- Transcribe an EPUB to `content.json` with **no OpenAI/vision calls**.
- Preserve EPUB structure as **Markdown** in each chunk's `text` field (headings, lists, bold/italic, blockquotes, links, tables).
- Generate a `metadata.json` from the EPUB nav/NCX so existing exporters render a clickable TOC and `## chapter` sections.
- Extract embedded images to disk and reference them from the Markdown.
- Flow a single `book.epub` path through the whole pipeline (transcribe → export) exactly like a PDF does today.
- Keep the existing exporters **unchanged** apart from `.epub` arg detection.

## Non-goals

- No OCR/vision fallback for EPUB. (A normal reflowable EPUB has no need; image-only "comic" EPUBs are out of scope for this pass.)
- No DRM handling. Input is assumed to be a readable, non-encrypted EPUB the user owns.
- No changes to PDF or Kindle code paths beyond adding the new branch.
- PDF/audio exporters are not taught to embed the extracted images; image references are a bonus for the Markdown export. (Audio TTS will naturally read any alt-text/caption that lands in the Markdown.)

---

## Architecture

A new module **`src/epub.ts`** mirrors `src/pdf.ts`: it wraps the third-party library behind a small, typed, immutable interface and is the only place that imports the EPUB lib. A third branch is added to `transcribe-book-content.ts`'s `main()`.

The unit of work is the **spine item** (one chapter/section in reading order), not a "page". EPUB has no fixed pagination; the spine *is* the canonical ordering.

### Libraries (both maintained, Node-native, new deps)

- **`epub2`** — resolves the zip container, OPF spine (reading order), manifest, and nav/NCX TOC; exposes chapter HTML and embedded image binaries via a promisified API (`EPub.createAsync`). Chosen over hand-rolling `jszip` + XML parsing to avoid re-implementing spine/manifest/nav edge cases.
- **`node-html-markdown`** — pure-Node XHTML→Markdown conversion with **no jsdom dependency** (unlike `turndown`). Supports headings, lists, bold/italic, blockquote, links, and tables, and allows a custom `img` translator to rewrite `src`.

`node-html-parser` (a transitive dep of `node-html-markdown`) is used for the pre-scan pass that locates `<img>` elements and resolves their hrefs against the manifest before conversion.

### `src/epub.ts` interface (sketch)

```ts
export interface EpubSpineItem {
  id: string          // OPF idref, used as the content.json screenshot key
  href: string        // path inside the zip, used to resolve relative img hrefs
  index: number       // 0-based position in spine reading order
}

export interface EpubTocEntry {
  title: string
  spineIndex: number  // 1-based spine position of the target file
}

export interface EpubMetadata {
  title: string
  authors: string[]
  language?: string
  publisher?: string
}

// Opens + caches the parsed EPUB (mirrors pdf.ts document caching).
export async function openEpub(epubPath: string): Promise<void>
export async function getEpubMetadata(epubPath: string): Promise<EpubMetadata>
export async function getEpubSpine(epubPath: string): Promise<EpubSpineItem[]>
export async function getEpubToc(epubPath: string): Promise<EpubTocEntry[]>
// Returns raw chapter XHTML for a spine item.
export async function getEpubChapterHtml(epubPath: string, id: string): Promise<string>
// Returns the binary + media type for a manifest image, by resolved href.
export async function getEpubImage(
  epubPath: string,
  href: string
): Promise<{ data: Buffer; mediaType: string } | null>
export async function closeEpub(epubPath: string): Promise<void>
```

A separate pure function (unit-testable without a real EPUB) does HTML→Markdown:

```ts
export function chapterHtmlToMarkdown(
  html: string,
  opts: {
    tocTitle?: string                          // for leading-title reconciliation
    rewriteImageSrc: (originalSrc: string) => string | null  // null => drop image
  }
): string
```

---

## Data flow

```
book.epub → epub2 → spine[] (reading order)
                  → manifest + nav/NCX → EpubTocEntry[]

  per spine item:
    chapter XHTML
      → pre-scan <img>: resolve href vs manifest → getEpubImage
          → write binary to out/<book>/images/<sanitized-file>
          → build src → "images/<file>" rewrite map
      → chapterHtmlToMarkdown(html, { tocTitle, rewriteImageSrc })
      → ContentChunk { index, page, text: markdown, screenshot: "epub:<id>" }

  → out/<book>/content.json   (one chunk per spine item, reading order)
  → out/<book>/metadata.json  (BookMetadata: meta + toc + pages)
  → out/<book>/images/        (extracted embedded images)
```

`out/<book>/` basename = `sanitizeDirname(path.basename(epubPath, path.extname(epubPath)))`, identical to the PDF branch (`transcribe-book-content.ts:424`).

---

## Mapping to existing types

So the exporters work unchanged, the EPUB branch emits the existing `ContentChunk` / `BookMetadata` shapes (`src/types.ts`).

### ContentChunk (per spine item)

| field | value |
|---|---|
| `index` | 0-based spine position |
| `page` | 1-based spine position (`index + 1`) |
| `text` | chapter Markdown |
| `screenshot` | `epub:<spineIdRef>` — idempotency key, mirrors `pdf:<path>#page=N` |

### metadata.json (`BookMetadata`)

- `meta.title`, `meta.authorList` from OPF Dublin Core (`dc:title`, `dc:creator`); `meta.language`/`meta.publisher` populated when present, other `BookMeta` fields filled with safe empty defaults (the markdown/PDF exporters only read `title` + `authorList` + `toc`).
- `pages` — one `PageChunk` per spine item: `{ index, page, total, screenshot }` where `total` = spine length.
- `toc` — `TocItem[]`; each entry's `page` = the 1-based spine index of its target file (nav anchors that point mid-file resolve to the containing spine item). `location` left undefined → exporter's `useLocationMode` stays false and `page` mode is used (`export-book-markdown.ts:251-257`).

The markdown exporter's existing **Kindle mode** (`export-book-markdown.ts:238+`) then renders the clickable TOC + `## chapter` sections; `export-book-pdf.ts` gets its TOC the same way.

---

## Heading reconciliation (key decision)

The exporter's Kindle mode prepends its own `## <TOC title>` to each section (`export-book-markdown.ts:309-313`). Converted chapter Markdown frequently *also* opens with that same title as an `<h1>`/`<h2>`, which would produce a duplicate heading.

**Decision:** normalize at conversion time, leave exporters untouched. `chapterHtmlToMarkdown`:

1. If the chapter's **leading heading** (first `<h1>`–`<h6>`) matches `tocTitle` (case/whitespace-insensitive), strip it.
2. **Demote** any remaining in-chapter headings by one level (`h1→h2`, `h2→h3`, …) so they nest correctly under the exporter-injected `##`.

Rejected alternative: patching the exporter to skip its title injection for EPUB — keeps logic split across files and risks regressing PDF/Kindle output.

---

## Pipeline ergonomics

Add `.epub` detection to `main()` in three files so one `book.epub` path flows end-to-end like a PDF:

- `transcribe-book-content.ts` — `isEpubMode = /\.epub$/i.test(arg)`; dispatch to the new branch.
- `export-book-markdown.ts` — treat `.epub` like `.pdf` for `outDir` resolution; since `metadata.json` exists, Kindle mode renders automatically.
- `export-book-pdf.ts` — same `.epub` → `outDir` resolution.

Idempotency (skip chunks whose `screenshot` key already exists in `content.json`) and `FORCE` behavior are reused unchanged — keyed on `epub:<id>`.

---

## Error handling & edge cases

- **Malformed / missing OPF spine, unreadable zip** → fail fast with a clear message (mirrors `assert(numPages > 0, ...)` in the PDF branch).
- **Spine item converting to empty/whitespace Markdown** → keep the chunk with the `[BLANK_PAGE]` marker (`TRANSCRIBE_BLANK_MARKER`, default `[BLANK_PAGE]`), consistent with PDF/Kindle blank handling, so `verify-book-content` doesn't report a content gap.
- **Image with no manifest entry / unreadable binary / unsupported media type** → skip that one image (`rewriteImageSrc` returns `null` → `<img>` dropped), keep surrounding text, log a warning. Never abort the chapter.
- **EPUB with no nav/NCX** → still emit `content.json`; `metadata.json` gets a minimal TOC with one entry per spine item titled from the chapter's leading heading (or `Section N` fallback). If even that is unavailable, omit `metadata.json` and let the exporter's content-only mode handle it.
- **Duplicate / colliding image filenames across chapters** → namespace extracted files by manifest id or a content hash to avoid overwrites in `out/<book>/images/`.

---

## Testing

Target ≥80% coverage on the new module, per repo testing rules.

- **Fixture:** commit a tiny hand-built `.epub` under `src/__tests__/fixtures/` — 2–3 spine items, a nav doc, and one embedded image. (A `.epub` is a zip; the fixture can be generated by a small build step or checked in as a binary.)
- **`src/epub.ts` unit tests:** spine reading order; TOC → spine-index mapping; image extraction + `src` rewrite; `getEpubMetadata` Dublin Core parsing.
- **`chapterHtmlToMarkdown` unit tests (no real EPUB needed):** heading/list/emphasis/blockquote/table preservation; leading-title stripping; heading demotion; image `src` rewrite and drop-on-null.
- **Integration test:** run the EPUB branch end-to-end on the fixture; assert the shape of `content.json` (chunk count = spine length, ordered, `epub:` keys) and `metadata.json` (`toc` length, `pages` length, title/authors).

---

## Files touched

| File | Change |
|---|---|
| `src/epub.ts` | **new** — EPUB container/spine/nav/image wrapper + `chapterHtmlToMarkdown` |
| `src/transcribe-book-content.ts` | new EPUB branch in `main()`; `.epub` detection |
| `src/export-book-markdown.ts` | `.epub` → `outDir` arg detection |
| `src/export-book-pdf.ts` | `.epub` → `outDir` arg detection |
| `src/__tests__/epub.test.ts` | **new** — unit + integration tests |
| `src/__tests__/fixtures/*.epub` | **new** — test fixture |
| `package.json` | add `epub2`, `node-html-markdown` deps |
| `CLAUDE.md` | document the EPUB workflow alongside PDF |

## Open questions

None blocking. Fixture-generation mechanism (checked-in binary vs. build-time zip) to be decided during implementation.
