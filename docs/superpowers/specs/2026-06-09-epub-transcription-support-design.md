# EPUB transcription support — design (v3)

**Date:** 2026-06-09
**Status:** Approved direction; revised after adversarial review rounds 1–2.
**Scope:** Add EPUB as a third input format to the transcribe pipeline, alongside Kindle screenshots and PDF.

> **Revision history**
> - **v1 → v2:** fixed `epub2.getImage` id-vs-href, `getChapter` rewriting img src, Node-20 requirement, `export-book-pdf.ts` having no arg parsing, the exporters' last-TOC-entry drop and duplicate-page slicing (trailing sentinel), and `verify`'s `unparseable-screenshot` rejection of `epub:` keys.
> - **v2 → v3:** (a) **chunk by nav section with anchor-aware splitting**, not by spine item — v2's spine-granularity collapsed single-file EPUBs (whole book in one XHTML) into one untitled section; (b) **dropped the `linear="no"` exclusion** — `epub2` does not expose the `linear` attribute; (c) `epub2` **named import** `{ EPub }`; (d) `verify` **Section-4 chapter-coverage** `isTrailer` fix for the sentinel; (e) heading title precedence inverted to kill the every-chapter double-heading; (f) image filenames keyed on **manifest id** + zip-slip rejection; (g) intra-EPUB link flattening; (h) heading-demote pre-pass made explicit.

---

## Problem

`src/transcribe-book-content.ts` has two input modes, branched on the CLI arg: **PDF mode** (`:415`, `/\.pdf$/i`, renders via `pdfjs-dist` + OCR fallback) and **Kindle screenshot mode** (the `else` branch, requires `ASIN` + PNGs in `out/${asin}/pages/`). An `.epub` falls through to the screenshot branch and fails at `assert(asin, ...)`.

EPUB is a zip of XHTML/CSS that already contains clean structured text and a real table of contents, so OCR/vision is unnecessary and would reduce fidelity. This adds a dedicated EPUB branch that parses the container directly and emits the same `content.json` + `metadata.json` artifacts the exporters consume.

## Goals

- Transcribe an EPUB to `content.json` with **no OpenAI/vision calls**.
- Preserve structure as **Markdown** per chunk (headings, lists, bold/italic, blockquotes, links, tables).
- Produce a `content.json` + `metadata.json` whose chunking and TOC render correctly through the **existing, unmodified** exporter section-walk — including **single-file EPUBs** where the nav is the only chapter structure.
- Extract embedded images to disk and reference them from the Markdown.
- Flow a single `book.epub` path through the whole pipeline.

## Non-goals

- No OCR/vision fallback. Fixed-layout/image-only "comic" EPUBs are out of scope this pass.
- No DRM handling (input assumed non-encrypted, owned).
- No re-architecting the exporters' section-walk; we adapt the **data** to its contract (only arg-parsing and one verify guard are added).
- PDF/audio exporters are not taught to embed images.

---

## Architecture

New module **`src/epub.ts`** mirrors `src/pdf.ts` (wraps the third-party lib behind a small typed interface; sole importer of the lib). A third branch is added to `transcribe-book-content.ts`'s `main()`; arg-parsing is added to both exporters' `main()`; one recognizer + one `isTrailer` tweak are added to `verify-book-content.ts`.

The unit of work is the **nav section** (see "Section model"), not the spine item.

### Libraries (new deps)

- **`epub2`** (`@3.0.2`) — zip container, OPF spine, manifest, nav/NCX TOC, raw chapter XHTML, image binaries.
  - **Import:** must be the **named** import — `import { EPub } from 'epub2'`. A default import resolves to the base class **without** `createAsync`/`*Async` methods (verified by runtime probe).
  - **Maintenance:** last published 2023-09; not actively maintained, but EPUB/OPF/NCX are frozen standards. Pulls `bluebird` + `adm-zip` transitively; `createAsync` returns a Bluebird thenable — always `await`.
  - **API facts the wrapper relies on** (verified against shipped `.d.ts`/`.js` + probes):
    - `EPub.createAsync(path)` → instance; rejects on parse error.
    - `instance.spine` / `instance.flow` — spine items as `TocElement` (`id`, `href`, `media-type`). **`linear` is NOT surfaced** — `parseSpine` never copies `itemref/@linear`. Hence the design must not depend on `linear` (see Section model / non-goals).
    - `instance.manifest` — `{ [id]: { href, 'media-type', ... } }` → build an href→id map.
    - `instance.metadata` — `{ creator?: string (single), title?, language?, publisher? }`. Multiple `<dc:creator>` collapse to one string (documented limitation).
    - `instance.toc` — NCX-derived `{ title, href?, order? }`; **may be empty for nav-only EPUB3** (see TOC source).
    - **`getChapterRawAsync(id)`** → **unmodified** XHTML. Used instead of `getChapterAsync` (which rewrites `<img src>` and strips `<head>`). Rejects on non-xhtml mime.
    - **`getImageAsync(id)`** → `[Buffer, mimeType]`, **keyed on manifest id**, **rejects** (not null) on missing/non-image.
- **`node-html-markdown`** — pure-Node XHTML→Markdown, **no jsdom**; headings, lists, bold/italic, blockquote, links, GFM tables, custom translators. `static translate(html, opts?, customTranslators?)` takes an HTML **string**, so we pre-mutate the DOM (image rewrite, leading-heading strip) with `node-html-parser`, serialize, then translate. Returning `{ ignore: true }` from a custom `img` translator drops an image; a custom `h1..h6` translator can read the node's level and emit a shifted/clamped prefix.
  - **Node:** `@2` requires `engines.node >= 20`. **Bump the repo minimum to Node 20** (`package.json` + CI matrix). Fallback: pin `node-html-markdown@^1`.
  - **Pin `node-html-parser@^6`** as a direct dep to match `node-html-markdown`'s copy and avoid a duplicate major in the tree.

### `src/epub.ts` interface (sketch)

```ts
export interface EpubSpineItem {
  id: string          // OPF idref
  href: string        // zip path; base dir for resolving relative hrefs
  index: number       // 0-based spine position
}

export interface EpubNavEntry {
  title: string
  fileHref: string    // target spine file (fragment stripped)
  fragment?: string   // element id within the file, if the nav target had one
  order: number       // document order across the flattened nav tree
}

export interface EpubMetadata {
  title: string
  authors: string[]   // epub2 single creator → [creator] or []
  language?: string
  publisher?: string
}

export async function openEpub(epubPath: string): Promise<void>
export async function getEpubMetadata(epubPath: string): Promise<EpubMetadata>
export async function getEpubSpine(epubPath: string): Promise<EpubSpineItem[]>
export async function getEpubNav(epubPath: string): Promise<EpubNavEntry[]>   // NCX or nav.xhtml, flattened depth-first
export async function getEpubChapterHtml(epubPath: string, id: string): Promise<string>  // getChapterRawAsync
// resolvedHref = zip-root-relative path already normalized + zip-slip-checked by caller.
// Wrapper owns href→id map, adapts [Buffer,string] tuple, catches rejection → null.
export async function getEpubImage(
  epubPath: string,
  resolvedHref: string
): Promise<{ data: Buffer; mediaType: string } | null>
export async function closeEpub(epubPath: string): Promise<void>
```

Pure, separately-tested converter:

```ts
export function sectionHtmlToMarkdown(
  html: string,                                            // a section's XHTML fragment
  opts: {
    sectionTitle: string                                   // becomes the exporter's ## heading
    stripLeadingHeading: boolean                           // strip the in-text title we promoted
    resolveImage: (originalSrc: string) => string | null   // "images/<file>" or null to drop; NOT called for data: URIs
  }
): string
```

---

## Section model (resolves the single-file-EPUB CRITICAL)

The exporter section-walk (`export-book-markdown.ts:290-316`, `export-book-pdf.ts:68-101`) requires, as **data**: a `content[]` ordered by a unique ascending `page`, and a `toc[]` whose `i`-th entry's `page` selects the `i`-th chunk, with a final terminator entry (it loops `i < toc.length - 1`). We satisfy this by producing an ordered list of **sections**, one chunk + one TOC entry each.

**Deriving sections (reading order):**

1. Build `navEntries` from NCX, else EPUB3 `nav.xhtml` (fragments preserved), flattened depth-first in document order.
2. Walk spine items in order. For each spine item `S` (raw XHTML via `getChapterRawAsync`, parsed with `node-html-parser`):
   - `hits` = nav entries whose `fileHref === S.href`, ordered by the document position of their `fragment` element within `S` (a no-fragment/topmost hit sorts first).
   - **≥1 fragment-bearing hits →** split `S`'s DOM at those fragment-element boundaries into segments (a segment runs from one anchored element up to, but excluding, the next). Content **before the first anchor** is the *lead segment*.
     - Each anchored segment → one **Section**; title = the segment's in-text leading heading, else the hit's nav title, else `Section {n}`.
     - Lead segment: if it has a leading heading → its own Section; else if it has substantive text → appended to the **previous** Section's body (continuation); else dropped.
     - A `fragment` with no matching element id is treated as top-of-file.
   - **Exactly one hit, no usable fragment →** `S` is one Section; title = in-text leading heading, else nav title, else `Section {n}`.
   - **No hits (orphan: cover, copyright, footnote popup, back-matter) →**
     - If `S` has a leading heading → its own Section (title = that heading).
     - Else (**merge-tiny rule**, prevents per-paragraph-file explosion and stray `Section N` noise) append `S`'s body to the **previous** Section; if there is no previous Section, `S` becomes Section 1 titled from metadata title or `Section 1`.
3. Result: ordered `Section[]`. Each → `ContentChunk` (`page = ordinal`, `index = ordinal-1`) + `TocItem` (`page = ordinal`). Append a **trailing sentinel** `TocItem` (`page` undefined, `total` = section count) so the exporter's `toc.length - 1` loop renders the real last section (its `nextPos` is undefined → `endIndex = content.length`). The sentinel is filtered out of the printed TOC (only defined-position entries are listed, `export-book-markdown.ts:280-286`).

This makes a single-file 30-chapter EPUB produce 30 sections, a one-file-per-chapter EPUB produce one section per file, and bounds the pathological one-file-per-paragraph case via merge-tiny. **Documented limitation:** sub-section nesting depth is flattened (one level of sections); two sections that resolve to the *same* fragment are de-duplicated to the first.

**Idempotency key:** `screenshot = epub:<sectionKey>` where `sectionKey = <spineId>` or `<spineId>#<fragment>` for split sections — stable across re-runs, unique per section, mirrors `pdf:<path>#page=N` (`transcribe-book-content.ts:528`). Reuses the existing `processedScreenshots` skip (`:479-484`). **`FORCE` is not implemented in transcribe** (only in extract/audio); not claimed here — re-transcribe means deleting `content.json`.

---

## Mapping to existing types

### ContentChunk (per section)

| field | value |
|---|---|
| `index` | 0-based section ordinal |
| `page` | ordinal (1-based, contiguous, unique) |
| `text` | section Markdown, or `[BLANK_PAGE]` only when the section Markdown (including image refs) is empty |
| `screenshot` | `epub:<sectionKey>` |

### metadata.json (`BookMetadata`)

- `meta.title` = first `dc:title`; `meta.authorList` = `creator ? [creator] : []`; `meta.language`/`publisher` when present.
- `meta` has **16 required fields** (`types.ts:22-43`); built from a concrete default factory (exporters read only `title`+`authorList`, but we populate the full shape): empty strings for `ACR/asin/bookSize/bookType/cover/publisher/refEmId/releaseDate/version`, `sample:false`, `positions:{cover:0,srl:0,toc:0}`, `startPosition:0`, `endPosition:` section count, plus `title/authorList/language`.
- `pages` — one `PageChunk{index,page,total,screenshot}` per section; `total` = section count.
- `toc` — per-section `TocItem{title,page,total}` (`location` undefined → page mode, `export-book-markdown.ts:251-257`) + trailing sentinel `{title:'',page:undefined,total}`.

**Fields each exporter reads** (verified): markdown → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`, `toc[].location`; pdf → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`. Defaults above are therefore safe.

---

## Heading reconciliation (resolves the every-chapter double-heading)

The exporter injects `## <toc title>` per section. To avoid a duplicate when the section body *also* opens with that title, the promoted title is **always stripped from the body**:

1. **Title precedence (per section):** in-text **leading heading** → else nav title → else `Section {n}`. The in-text heading wins so that, for a novel where nav says "Chapter 1" but the page reads "The Funeral", the rendered section title and TOC link are **"The Funeral"** and the body no longer repeats it. (Trade-off: TOC-link text may differ from the nav label — cosmetic, far better than a duplicate heading on every chapter.) "Leading heading" = the first `<h1>`–`<h6>` in document order within the section.
2. **Strip:** when `stripLeadingHeading` is set (i.e. the title came from the in-text leading heading), remove that heading node before conversion.
3. **Demote with clamp (needs a pre-pass):** the `node-html-parser` pre-scan computes the section's **minimum remaining heading level** `m`; the custom `h1..h6` translator emits level `min(6, level + (3 - m))` so the shallowest remaining heading becomes `h3` (nested under the exporter's `h2`). Relative depth is preserved **up to h6**; deeper levels are clamped and may merge (rare; acknowledged, not "lossless").

---

## Image extraction (resolves zip-slip + collisions)

- Raw XHTML via `getChapterRawAsync`; pre-scan `<img>` with `node-html-parser`. The `img` translator checks the `src` scheme **before** calling `resolveImage`:
  - **`data:` URI** → passed through untouched (not extracted). **SVG-wrapped `<image xlink:href>` and `srcset`** are out of scope v1 (documented); text unaffected.
  - Otherwise: resolve `src` against `dirname(spineItem.href)`, normalize `.`/`..` to a **zip-root-relative** path. **Reject (drop image + warn) any path that escapes the zip root** (zip-slip guard). Look up the normalized href in the manifest (href→id) → `getEpubImage`.
- **Filename = manifest `id`** (unique per OPF spec) + original extension, sanitized (`sanitizeDirname`). Written to `out/<book>/images/<id>.<ext>`; the same name is used in the rewritten Markdown `src` (`images/<id>.<ext>`), so write-path and reference always agree and **cannot collide** (manifest ids are unique). Before writing, assert the resolved target path is contained within `out/<book>/images/`.
- On miss/unreadable/non-image/rejection → `resolveImage` returns `null`, `<img>` dropped, text kept, warning logged. Never abort the section.
- **Cover/image-only/text-light sections:** convert first (image refs included); mark `[BLANK_PAGE]` **only if the result is empty**, so a cover keeps its image reference.

---

## Links & encoding contract

- **Intra-EPUB links** (`<a href>` targeting a spine/manifest file, with/without fragment): **flattened to plain text** (link text kept, `href` dropped). This avoids dead relative links in the single combined Markdown (footnote markers, cross-chapter refs). **External** `http(s)`/`mailto` links are preserved. (Footnote *content* itself is not lost: orphan footnote spine items become their own sections per the Section model, since `linear` can't be read to exclude them.)
- Bytes read UTF-8; HTML entities decoded; `&nbsp;`/`&#160;` → space; `&shy;` removed; `<pre>` → fenced code; insignificant inter-tag whitespace collapsed (node-html-markdown default).
- EPUB chunks are 1:1 with sections (no multi-screen overlap), so `joinChunksDedupingOverlap` (`export-book-markdown.ts:26`) is effectively a no-op for EPUB output.

---

## Pipeline ergonomics

`.epub` detection added to three `main()`s so one `book.epub` flows end-to-end:

- `transcribe-book-content.ts` — `isEpubMode = /\.epub$/i.test(arg)`; `out/<base>` via `sanitizeDirname(path.basename(epubPath, path.extname(epubPath)))` (as PDF branch, `:424`).
- `export-book-markdown.ts` — extend the existing `.pdf` arg test (`:336-356`) to accept `.epub`; Kindle mode renders automatically.
- `export-book-pdf.ts` — **add `main()` arg-parsing** (none today; `:12-16` hardwired to `ASIN`), mirroring the markdown exporter: `.pdf`/`.epub` → `out/<basename>`; else `path.resolve(arg)`; else `ASIN`.

---

## verify-book-content compatibility (two changes)

1. **`epub:` keys** — `parseScreenshotFilename` (utils.ts:69, `\d+-\d+\.png` only) and `parsePdfRef` both return null for `epub:<…>`, so every EPUB chunk would be flagged `unparseable-screenshot` (and the CLI sets `exitCode=1`). **Add `EPUB_REF_RE = /^epub:.+$/`** as a third recognizer in that branch (`verify-book-content.ts:173-197`), parallel to `parsePdfRef`, so EPUB keys are recognized and skipped.
2. **Section-4 chapter-coverage `isTrailer`** (`:391-421`) — runs whenever `metadata.json` exists (always, for EPUB). Interior sections span exactly 1 page so the `nextPage - item.page <= 1` guard (`:408`) skips them; only the **last** section is evaluated. The current `isTrailer = !finite(nextPage) && i === toc.length - 1` (`:399`) is defeated by our sentinel (real last section sits at `toc.length - 2`), so a `[BLANK_PAGE]` final section would raise `empty-chapter`. **Change the index check to the last entry with a numeric `page`** (`i === lastIndexWithNumericPage(toc)`): identical behavior for Kindle/PDF (their last entry has a page), correct for the EPUB sentinel.

Other verify checks are inert for EPUB: `duplicate-screenshot` (keys unique), orphan/missing-screenshot (gated on PNGs in `pages/`, none exist), PDF coverage (`parsePdfRef` null). The blank-marker check already treats `[BLANK_PAGE]` correctly.

---

## Error handling & edge cases

- Malformed/missing OPF spine, unreadable zip → fail fast with a clear message (mirrors `assert(numPages > 0)`).
- Empty section Markdown → `[BLANK_PAGE]`.
- Image miss/unreadable/zip-slip/non-image → drop image, keep text, warn.
- No NCX **and** no nav → every spine item is an orphan → merge-tiny yields one section per heading-bearing file (title from leading heading or `Section N`); `metadata.json` still emitted (never content-only mode, whose `formatPdfTextToMarkdown` would mangle real Markdown).
- TOC anchor-slug collisions for duplicate/empty titles — pre-existing exporter behavior (`title.toLowerCase().replace(/[^\da-z]+/g,'-')`, `:284`); **documented known limitation**.
- **Sentinel coupling caveat:** the trailing sentinel is load-bearing; a future exporter refactor that "fixes" the `toc.length - 1` off-by-one would make the sentinel render as an empty section. Noted for whoever touches the section-walk.

---

## Testing

Target ≥80% on `src/epub.ts` + `sectionHtmlToMarkdown`.

- **Fixture:** commit EPUB **source files** under `src/__tests__/fixtures/epub-src/` exercising the hard cases: **(a) a single XHTML file with 3 chapters delineated by `#frag` nav anchors** (the C1 case), **(b) one orphan front-matter file with no nav entry**, **(c) one referenced image**, **(d) an intra-book footnote link**, **(e) a text-rich final section** (so Section-4 stays green). A helper `buildFixtureEpub()` zips them at runtime with **`jszip`** (devDep), adding `mimetype` **first and STORED** (`{compression:'STORE'}`) per EPUB OCF.
- **`src/epub.ts` unit tests:** spine order; nav flattening + fragment parse; **anchor-aware section split** (the single-file case → 3 sections); orphan/merge-tiny behavior; trailing sentinel; href→id image resolution against the spine dir; **zip-slip rejection**; single-creator → `authorList`.
- **`sectionHtmlToMarkdown` unit tests:** heading/list/emphasis/blockquote/table preservation; leading-title promotion+strip (no duplicate); demote-to-h3 via min-level pre-pass + h6 clamp; image rewrite + drop-on-null + **data-URI pass-through**; intra-EPUB link flattening vs external-link retention; `&nbsp;`/`&shy;` normalization.
- **Integration test:** run the EPUB branch end-to-end on the fixture; assert `content.json` (section count, ordering, `epub:` keys, cover keeps image ref not `[BLANK_PAGE]`) and `metadata.json` (`toc` = sections + 1 sentinel, `pages`, title/authors). Then run `verifyBookContent` and assert **zero `unparseable-screenshot` AND zero `empty-chapter`** issues.

---

## Files touched

| File | Change |
|---|---|
| `src/epub.ts` | **new** — wrapper (`{ EPub }` named import, `getChapterRawAsync`, nav flatten, href→id image map, zip-slip guard) + section derivation helpers + `sectionHtmlToMarkdown` |
| `src/transcribe-book-content.ts` | new EPUB branch in `main()`; `.epub` detection |
| `src/export-book-markdown.ts` | extend arg detection to `.epub` |
| `src/export-book-pdf.ts` | **add `main()` arg-parsing** (none today) |
| `src/verify-book-content.ts` | add `EPUB_REF_RE`; fix `isTrailer` to last numeric-page entry |
| `src/__tests__/epub.test.ts` | **new** — unit + integration tests |
| `src/__tests__/fixtures/epub-src/**` | **new** — fixture sources (single-file + orphan + image + footnote) |
| `src/__tests__/helpers/build-fixture-epub.ts` | **new** — `jszip` fixture zipper (mimetype first/STORED) |
| `package.json` | add `epub2`, `node-html-markdown`, `node-html-parser@^6` deps + `jszip` devDep; bump `engines.node` to `>=20` |
| `.github/workflows/*` | bump CI Node matrix to 20 |
| `CLAUDE.md` | document the EPUB workflow alongside PDF |

## Known limitations (intended, documented)

- Nav hierarchy flattened to one section level; duplicate-fragment nav entries de-duplicated.
- Multi-author EPUBs collapse to a single `creator` string (epub2).
- SVG-wrapped/`srcset`/data-URI images not extracted in v1 (data-URIs passed through).
- Intra-EPUB hyperlinks flattened to text (footnote *content* preserved as orphan sections).
- TOC anchor-slug collisions for duplicate/empty titles (pre-existing exporter behavior).
- Section title may differ from the nav label when an in-text heading is present (intentional, avoids double headings).
