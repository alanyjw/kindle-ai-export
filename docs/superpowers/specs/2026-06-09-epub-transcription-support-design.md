# EPUB transcription support — design (v2)

**Date:** 2026-06-09
**Status:** Approved direction; revised after adversarial review round 1.
**Scope:** Add EPUB as a third input format to the transcribe pipeline, alongside Kindle screenshots and PDF.

> **Revision note (v2):** v1 was reviewed by three adversarial agents against the actual `epub2` / `node-html-markdown` source and the real exporter code. This version resolves the blockers they found: the `epub2.getImage` id-vs-href mismatch, `getChapter` rewriting img src, the Node-20 requirement, `export-book-pdf.ts` having no arg parsing, the exporters' last-TOC-entry drop and duplicate-page slicing bugs, and `verify-book-content` rejecting `epub:` keys. The load-bearing change is the **TOC ↔ content mapping** (see that section).

---

## Problem

`src/transcribe-book-content.ts` has exactly two input modes, branched on the CLI arg:

- **PDF mode** — `transcribe-book-content.ts:415`: `isPdfMode = /\.pdf$/i.test(arg)`. Renders pages via `pdfjs-dist`, prefers embedded text, falls back to OpenAI vision OCR.
- **Kindle screenshot mode** (the `else` branch) — requires `ASIN` env + pre-extracted PNGs in `out/${asin}/pages/`, OCRs every page.

An `.epub` passed today falls through to the screenshot branch (it is not `.pdf`) and fails at `assert(asin, ...)` or "no page screenshots found".

EPUB is a zip of XHTML/CSS that **already contains clean, structured text and a real table of contents**. OCR/vision is unnecessary and would *reduce* fidelity. This design adds a dedicated EPUB branch that parses the container directly and produces the same `content.json` + `metadata.json` artifacts the downstream exporters consume.

## Goals

- Transcribe an EPUB to `content.json` with **no OpenAI/vision calls**.
- Preserve EPUB structure as **Markdown** in each chunk's `text` field (headings, lists, bold/italic, blockquotes, links, tables).
- Generate a `metadata.json` whose `toc`/`pages` are shaped to render correctly through the **existing, unmodified** exporter section-walk.
- Extract embedded images to disk and reference them from the Markdown.
- Flow a single `book.epub` path through the whole pipeline (transcribe → export).

## Non-goals

- No OCR/vision fallback for EPUB. Image-only "fixed-layout/comic" EPUBs are out of scope for this pass.
- No DRM handling. Input is assumed non-encrypted and owned by the user.
- No re-architecting of the exporters' section-walk. We adapt the **data** to the existing contract rather than change the exporters' logic (only arg-parsing is added).
- PDF/audio exporters are not taught to embed images; image references are a Markdown-only bonus.

---

## Architecture

A new module **`src/epub.ts`** mirrors `src/pdf.ts`: it wraps the third-party library behind a small, typed, immutable interface and is the only place that imports the EPUB lib. A third branch is added to `transcribe-book-content.ts`'s `main()`. A small recognizer is added to `verify-book-content.ts`, and arg-parsing is added to both exporters' `main()`.

The unit of work is the **linear spine item** (one chapter/section in reading order, `linear="no"` items excluded — see Ordering). EPUB has no fixed pagination; the linear spine *is* the canonical ordering.

### Libraries (new deps)

- **`epub2`** — resolves the zip container, OPF spine, manifest, and nav/NCX TOC; exposes raw chapter XHTML and image binaries.
  - **Maintenance caveat:** `epub2@3.0.2` was last published 2023-09. It is not actively maintained, but EPUB/OPF/NCX are frozen standards so bit-rot risk is low. It pulls `bluebird` and `adm-zip` transitively; `createAsync` returns a Bluebird thenable (always `await`, don't rely on native-Promise-only behavior).
  - **API facts the wrapper must respect** (verified against `epub2` `.d.ts` source):
    - `EPub.createAsync(path)` → parsed instance.
    - `instance.spine` / `instance.flow` — spine items (carry `id`, `href`); reading order.
    - `instance.manifest` — `{ [id]: { href, 'media-type', ... } }`.
    - `instance.metadata` — `{ creator?: string (single, not array), title?, language?, publisher?, ... }`.
    - `instance.toc` — NCX-derived entries (`{ title, href?, order? }`); may be empty for nav-only EPUB3.
    - **`getChapterRawAsync(id)`** — returns **unmodified** XHTML. We MUST use this, not `getChapterAsync`, because `getChapter` rewrites every `<img src>` and strips `<head>`, destroying the original hrefs we need for image resolution.
    - **`getImageAsync(id)`** — returns `[Buffer, mimeType]` **keyed on manifest id, not href**, and **rejects** (does not return null) when the id is missing/non-image.
- **`node-html-markdown`** — pure-Node XHTML→Markdown, **no jsdom**. Built-in support for headings, lists, bold/italic, blockquote, links, GFM tables, and a custom `img` translator (returning `{ ignore: true }` drops an image). Its only runtime dep is `node-html-parser`, which we also use directly for the image pre-scan and leading-heading strip.
  - **Node requirement:** `node-html-markdown@2` declares `engines.node >= 20`. **We bump the repo's minimum to Node 20** (update `package.json` `engines.node` to `>=20` and the CI matrix). Fallback if Node 18 must be retained: pin `node-html-markdown@^1` and re-verify its translator API.
  - **Heading demote/strip are NOT config flags.** They are implemented by us (see Heading reconciliation): a custom `h1..h6` translator for demotion (with clamp) plus a pre-parse drop of the leading heading node.

### `src/epub.ts` interface (sketch)

```ts
export interface EpubSpineItem {
  id: string          // OPF idref → content.json screenshot key + getImage lookups
  href: string        // path inside the zip; base dir for resolving relative img src
  index: number       // 0-based position among LINEAR spine items
  linear: boolean
}

export interface EpubTocEntry {
  title: string
  spineIndex: number  // 1-based linear-spine position of the target file
}

export interface EpubMetadata {
  title: string
  authors: string[]   // epub2 yields a single creator string → [creator] or []
  language?: string
  publisher?: string
}

export async function openEpub(epubPath: string): Promise<void>       // parse + cache
export async function getEpubMetadata(epubPath: string): Promise<EpubMetadata>
export async function getEpubSpine(epubPath: string): Promise<EpubSpineItem[]>   // linear only
export async function getEpubToc(epubPath: string): Promise<EpubTocEntry[]>      // fragments stripped, mapped to spine index
export async function getEpubChapterHtml(epubPath: string, id: string): Promise<string>  // getChapterRawAsync
// href is resolved+normalized against the spine item's dir by the CALLER; the wrapper
// owns the href→manifest-id map internally and adapts the [Buffer, string] tuple,
// catching getImageAsync rejection → null.
export async function getEpubImage(
  epubPath: string,
  resolvedHref: string
): Promise<{ data: Buffer; mediaType: string } | null>
export async function closeEpub(epubPath: string): Promise<void>
```

Pure, separately-tested conversion function (no real EPUB needed):

```ts
export function chapterHtmlToMarkdown(
  html: string,
  opts: {
    tocTitle: string                                       // section title for this chunk
    resolveImage: (originalSrc: string) => string | null   // returns "images/<file>" or null to drop
  }
): string
```

---

## TOC ↔ content mapping (load-bearing — resolves the round-1 CRITICALs)

The existing exporters (`export-book-markdown.ts:290-316`, `export-book-pdf.ts:68-101`) share a section-walk with three hard assumptions we must satisfy with DATA, not code changes:

1. The loop runs `for (i = 0; i < toc.length - 1; i++)` — **the final TOC entry is never rendered**; it is treated as a terminator/sentinel.
2. Section bounds use `startIndex = content.findIndex(c => c.page >= pos)` and `endIndex = nextPos !== undefined ? findIndex(c => c.page >= nextPos) : content.length`. So **two TOC entries with the same `page` yield an empty slice**, and **content before the first TOC entry's page is dropped**.
3. Page-vs-location mode is decided by majority (`export-book-markdown.ts:251-257`); leaving every `location` undefined keeps **page mode**.

To make a perfectly ordinary EPUB (sub-sections inside a chapter file, real front-/back-matter, a real final chapter) render correctly, the EPUB branch emits a **canonical, collision-free TOC**:

- **One `ContentChunk` per linear spine item.** `index` = 0-based linear position; `page` = `index + 1` (contiguous, all distinct). `screenshot` = `epub:<spineId>`.
- **One `TocItem` per linear spine item**, in order, with `page` = that item's 1-based linear-spine index. Because every chunk's `page` is unique and every spine item gets exactly one TOC entry at the same `page`, **there are no duplicate-page collisions, no empty sections, and no orphaned/dropped spine items.** Each chunk maps to exactly one section.
- **Title selection per entry:** the nav/NCX title whose target resolves to this spine item (topmost if several) → else the chapter's leading heading text → else `"Section {n}"`.
- **Append a trailing sentinel `TocItem` with `page` omitted (undefined).** This makes the loop's `toc.length - 1` bound stop on the sentinel instead of dropping the real last chapter; for the real last chapter `nextPos` is `undefined`, so `endIndex = content.length` and it renders fully. The sentinel is filtered out of the printed TOC because the TOC block only lists entries with a defined position (`export-book-markdown.ts:280-286`).
- `location` is left undefined on every entry → page mode (assumption 3).

**Consequence (documented limitation):** rich nav hierarchy and mid-file sub-section anchors are **flattened to spine-item granularity**. The nav's titles are preserved where a nav entry begins a spine file; finer sub-chapter divisions within one file are not separate sections. This is a deliberate trade for correctness and completeness. Hierarchical/nested nav is flattened depth-first when choosing the per-spine title.

---

## Mapping to existing types

`ContentChunk` (`src/types.ts:1-6`) and `BookMetadata` shapes are emitted exactly.

### ContentChunk (per linear spine item)

| field | value |
|---|---|
| `index` | 0-based linear-spine position |
| `page` | `index + 1` |
| `text` | chapter Markdown (or `[BLANK_PAGE]` only when truly empty — see edge cases) |
| `screenshot` | `epub:<spineIdRef>` — idempotency key, mirrors `pdf:<path>#page=N` (`transcribe-book-content.ts:528`) |

### metadata.json (`BookMetadata`)

- `meta.title` = first `dc:title`; `meta.authorList` = `metadata.creator ? [creator] : []` (epub2 collapses multiple `<dc:creator>` to one string — multi-author fidelity is a documented limitation). `meta.language`/`meta.publisher` filled when present.
- **`meta` requires ~18 non-optional fields** (`types.ts:22-43`). The branch builds them from a concrete default factory; the exporters read only `meta.title` + `meta.authorList`, but we populate the full shape to satisfy the type and any future reader. Defaults: empty strings for id-like fields (`ACR`,`asin`,`bookSize`,`bookType`,`cover`,`publisher`,`refEmId`,`releaseDate`,`version`), `sample:false`, `positions:{cover:0,srl:0,toc:0}`, `startPosition:0`, `endPosition:` spine length.
- `pages` — one `PageChunk` per linear spine item: `{ index, page, total, screenshot }`, `total` = linear-spine length.
- `toc` — the canonical `TocItem[]` defined above (per-spine entries + trailing sentinel). Every non-sentinel entry sets `page`, leaves `location` undefined, `total` = spine length.

**Fields each exporter actually reads** (verified): markdown → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`, `toc[].location`; pdf → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`. Neither reads `info`/`pages` body fields, so the defaults above are safe.

---

## Heading reconciliation

The exporter injects `## <TOC title>` per section (`export-book-markdown.ts:309-313`; pdf renders the title too). Converted chapter Markdown often *also* opens with that title as a heading. `chapterHtmlToMarkdown` normalizes, in this order:

1. **Derive then strip.** The section's `tocTitle` is decided upstream (nav → leading heading → `Section N`). If the chapter's first heading (`<h1>`–`<h6>`) is **normalized-equal** (case- and whitespace-insensitive, entity-decoded, footnote-marker-stripped) to `tocTitle`, drop that heading node before conversion. A *near-miss* (nav title ≠ in-text heading, e.g. "Chapter 1" vs "The Beginning") is **left in place** — accepted as a known double-heading case rather than risking an over-eager fuzzy strip.
2. **Demote with clamp.** Remaining headings are shifted so the chapter's **shallowest** remaining heading maps to `h3` (nesting under the exporter's `h2`), preserving relative depth, **clamped at `h6`** (never emit 7+ `#`). Implemented as a custom `node-html-markdown` heading translator computing the per-chapter offset.

---

## Image extraction

- Read raw XHTML via `getChapterRawAsync` (so original `src` survives).
- Pre-scan with `node-html-parser` for `<img>` elements only. For each `src`:
  - **data-URI** (`data:...`) → out of scope; left untouched (not extracted, not dropped silently — passed to the converter as-is). **SVG-wrapped `<image xlink:href>` and `srcset`** are out of scope for v1 (documented); surrounding text is unaffected.
  - Otherwise: resolve `src` against `dirname(spineItem.href)` and normalize `..`/`.` to a zip-root-relative path. Look it up in the manifest (href→id map) → `getEpubImage` → `{data, mediaType}`.
  - On success, write the binary to `out/<book>/images/<flatName>` where **`flatName` = the zip-relative manifest href with `/` replaced by `__`** (e.g. `OEBPS/images/x.png` → `OEBPS__images__x.png`). This single naming function is used for **both** the on-disk filename and the rewritten Markdown `src` (`images/<flatName>`), guaranteeing uniqueness within the EPUB and consistency between write and reference.
  - On miss / unreadable / non-image / `getImageAsync` rejection → `resolveImage` returns `null`, the `<img>` is dropped (`{ignore:true}`), surrounding text kept, warning logged. Never abort the chapter.
- **Cover-image-only / text-light spine items:** convert first (image refs included). The chunk is `[BLANK_PAGE]` **only if the resulting Markdown — including image references — is empty**, so a cover page keeps its image reference rather than being marked blank.

---

## Ordering & chunk-count invariant

- **`linear="no"` spine items (footnote popups, etc.) are excluded** from chunks and from numbering; `index`/`page` stay contiguous over the linear items only.
- The integration-test invariant is **"one chunk per *linear* spine item"** (not raw spine length), matching the exclusion above, so a correct implementation doesn't fail the test.
- EPUB **always emits `metadata.json`**, so the exporter always takes Kindle mode and **never** falls into content-only mode (whose `formatPdfTextToMarkdown` would mangle real Markdown by treating `## ` / `Chapter N` lines as OCR artifacts). The no-nav case still emits a synthetic per-spine-item TOC, so this holds even with no NCX/nav.

---

## Encoding / normalization contract

- Chapter bytes read as UTF-8 (epub2 handles declared charset).
- HTML entities decoded to Unicode; `&nbsp;`/`&#160;` → regular space; `&shy;` (soft hyphen) removed. `<pre>` preserved as fenced code. Insignificant inter-tag whitespace collapsed per HTML norms (node-html-markdown default).
- This is independent of `joinChunksDedupingOverlap` (`export-book-markdown.ts:26`): EPUB chunks are 1:1 with spine items and don't overlap like multi-screen Kindle captures, so the dedupe pass is effectively a no-op for EPUB output.

---

## Pipeline ergonomics

`.epub` detection added to three `main()`s so one `book.epub` path flows end-to-end like a PDF:

- `transcribe-book-content.ts` — `isEpubMode = /\.epub$/i.test(arg)`; dispatch to the new branch; `out/<base>` from `sanitizeDirname(path.basename(epubPath, path.extname(epubPath)))` (identical to PDF branch, `transcribe-book-content.ts:424`).
- `export-book-markdown.ts` — already arg-aware (`:336-356`); extend the `.pdf` test to also accept `.epub` for `outDir` resolution. Since `metadata.json` exists, Kindle mode renders automatically.
- `export-book-pdf.ts` — **has no arg parsing today** (`:12-16` is hardwired to `ASIN`). Add `main()` arg-parsing mirroring `export-book-markdown.ts:336-356`: if `arg` ends in `.pdf`/`.epub` → `outDir = path.join('out', sanitizeDirname(basename))`; else if `arg` → `outDir = path.resolve(arg)`; else fall back to `ASIN`. (Note `:73`'s `nextTocItem.page ? …` is truthy-based, but our pages are ≥1 so no `page===0` hazard.)

**Idempotency:** the existing `processedScreenshots` skip (`transcribe-book-content.ts:479-484`, PDF analog `:528-531`) is reused, keyed on `epub:<id>`. **`FORCE` is *not* implemented in transcribe** (it only exists in `extract-kindle-book.ts` / `export-book-audio.ts`); we do **not** claim FORCE support here. Re-transcribing an EPUB from scratch means deleting `content.json` (or the relevant chunks), consistent with current transcribe behavior.

---

## verify-book-content compatibility (resolves round-1 CRITICAL)

`verify-book-content.ts` calls `parseScreenshotFilename` (utils.ts:69, matches only `\d+-\d+\.png`) then `parsePdfRef` (matches only `^pdf:…#page=N$`). An `epub:<id>` key matches neither → every EPUB chunk is reported as `unparseable-screenshot` and the standalone CLI sets `exitCode=1`.

**Fix:** add an `EPUB_REF_RE = /^epub:.+$/` recognizer in `verify-book-content.ts`, parallel to `parsePdfRef`, so EPUB keys are recognized and skipped in the screenshot-parse check (same way PDF refs are). `verify-book-content.ts` is added to Files-touched. The blank-marker check already treats `[BLANK_PAGE]` correctly (`TRANSCRIBE_BLANK_MARKER`, `transcribe-book-content.ts:510`).

---

## Error handling & edge cases

- **Malformed/missing OPF spine, unreadable zip** → fail fast with a clear message (mirrors `assert(numPages > 0)`).
- **Empty/whitespace chapter Markdown (after image refs)** → `[BLANK_PAGE]` marker, so the verify empty-chapter check stays satisfied.
- **Image miss/unreadable/non-image** → drop that image, keep text, warn.
- **No NCX and no nav** → synthesize one TOC entry per spine item (title = leading heading or `Section N`) + sentinel; still emit `metadata.json` (never content-only mode).
- **Duplicate/empty TOC anchor slugs** — the exporter builds anchors via `title.toLowerCase().replace(/[^\da-z]+/g,'-')` (`:284`); repeated titles ("Notes") or CJK/numeric titles collide or empty out. Pre-existing exporter behavior; **documented known limitation**, not fixed here.

---

## Testing

Target ≥80% coverage on `src/epub.ts` + `chapterHtmlToMarkdown`.

- **Fixture:** commit the EPUB **source files** (mimetype, container.xml, OPF, 2–3 XHTML chapters incl. front-matter with no nav entry, a nav doc, one referenced image, and one `linear="no"` item) as a plain directory under `src/__tests__/fixtures/epub-src/`. A test helper `buildFixtureEpub()` zips them into a temp `.epub` at runtime using **`jszip`** (added as a devDependency) — keeps the fixture diffable/reviewable and deterministic, avoids committing a binary.
- **`src/epub.ts` unit tests:** linear-spine order + `linear="no"` exclusion; TOC→spine-index mapping with fragment stripping; trailing-sentinel presence; href→id image resolution against the spine dir + tuple/`null` adaptation; `getEpubMetadata` single-creator → `authorList`.
- **`chapterHtmlToMarkdown` unit tests:** heading/list/emphasis/blockquote/table preservation; leading-title strip (match) and retain (near-miss); demotion-to-h3 with h6 clamp; image `src` rewrite and drop-on-null; entity/`&nbsp;` normalization; data-URI pass-through.
- **Integration test:** run the EPUB branch end-to-end on the fixture; assert `content.json` (chunk count == linear-spine length, ordered, `epub:` keys, cover chunk keeps image ref not `[BLANK_PAGE]`) and `metadata.json` (`toc` = spine count + 1 sentinel, `pages` length, title/authors). Then run `verifyBookContent` on the output and assert **zero `unparseable-screenshot` issues**.

---

## Files touched

| File | Change |
|---|---|
| `src/epub.ts` | **new** — EPUB container/spine/nav/image wrapper (`getChapterRawAsync`, href→id image map, tuple/null adaptation) + `chapterHtmlToMarkdown` |
| `src/transcribe-book-content.ts` | new EPUB branch in `main()`; `.epub` detection |
| `src/export-book-markdown.ts` | extend arg detection to `.epub` |
| `src/export-book-pdf.ts` | **add `main()` arg-parsing** (`.pdf`/`.epub`/outDir/ASIN) — none exists today |
| `src/verify-book-content.ts` | add `EPUB_REF_RE` recognizer so `epub:` keys aren't flagged |
| `src/__tests__/epub.test.ts` | **new** — unit + integration tests |
| `src/__tests__/fixtures/epub-src/**` | **new** — unzipped fixture sources |
| `src/__tests__/helpers/build-fixture-epub.ts` | **new** — `jszip` fixture zipper |
| `package.json` | add `epub2`, `node-html-markdown` deps + `jszip` devDep; bump `engines.node` to `>=20` |
| `.github/workflows/*` | bump CI Node matrix to 20 |
| `CLAUDE.md` | document the EPUB workflow alongside PDF |

## Resolved questions (were open in v1)

- **Fixture format:** decided — unzipped sources + runtime `jszip` builder (not a checked-in binary).
- **Image id-vs-href, getChapter rewriting, Node 20, pdf-exporter arg parsing, last-chapter drop, duplicate-page slicing, verify rejecting epub keys, FORCE, linear="no", multi-author** — all resolved above.

## Remaining known limitations (intended, documented)

- Nav hierarchy/mid-file sub-sections flattened to spine granularity.
- Multi-author EPUBs collapse to a single `creator` string (epub2 limitation).
- SVG-wrapped/`srcset`/data-URI images not extracted in v1.
- TOC anchor-slug collisions for duplicate/empty titles (pre-existing exporter behavior).
