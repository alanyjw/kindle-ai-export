# EPUB transcription support — design (v5)

**Date:** 2026-06-09
**Status:** Ready for implementation plan; hardened across adversarial review rounds 1–4 (verdict: SHIP).
**Scope:** Add EPUB as a third input format to the transcribe pipeline, alongside Kindle screenshots and PDF.

> **Revision history**
> - **v1 → v2:** fixed `epub2.getImage` id-vs-href, `getChapter` rewriting img src, Node-20 requirement, `export-book-pdf.ts` having no arg parsing, the exporters' last-TOC-entry drop and duplicate-page slicing (trailing sentinel), and `verify`'s `unparseable-screenshot` rejection of `epub:` keys.
> - **v2 → v3:** chunk by **nav section with anchor-aware splitting** (single-file EPUBs collapsed under spine-granularity); dropped `linear="no"` exclusion (`epub2` doesn't surface `linear`); `{ EPub }` named import; `verify` Section-4 `isTrailer` fix; heading title precedence; image-id filenames + zip-slip; intra-EPUB link flattening; heading-demote pre-pass.
> - **v3 → v4:** (a) **nav-only EPUB3 nav.xhtml is parsed manually** via `getFileAsync` + manifest `properties="nav"` — `epub2`'s TOC parse is NCX-only; (b) **heading junk-guard** before promoting an in-text heading to a title; (c) **image filename collision** fixed (Set-disambiguation + extension from media-type); (d) concrete **anchor-split algorithm** with block-boundary promotion; (e) lead-merge constrained to within the same spine file; (f) every-nav-entry-yields-one-section invariant; (g) precise intra-link detection + unwrap-not-text ordering.
> - **v4 → v5:** (a) image **id→name memo** so a shared image referenced from two sections is one file (round-4 CRITICAL); (b) junk-guard predicate widened to letter-**or-digit** so numeric titles like "1984" aren't rejected (round-4 HIGH); (c) orphan spine files become their own section (no cross-file merge — avoids content misattribution); (d) block-helper degenerate-anchor fallback; `lastIndexWithNumericPage` defined.

---

## Problem

`src/transcribe-book-content.ts` has two input modes, branched on the CLI arg: **PDF mode** (`:415`, `/\.pdf$/i`, renders via `pdfjs-dist` + OCR fallback) and **Kindle screenshot mode** (the `else` branch, requires `ASIN` + PNGs in `out/${asin}/pages/`). An `.epub` falls through and fails at `assert(asin, ...)`.

EPUB is a zip of XHTML/CSS that already contains clean structured text and a real table of contents, so OCR/vision is unnecessary and would reduce fidelity. This adds a dedicated EPUB branch that parses the container directly and emits the same `content.json` + `metadata.json` artifacts the exporters consume.

## Goals

- Transcribe an EPUB to `content.json` with **no OpenAI/vision calls**.
- Preserve structure as **Markdown** per chunk (headings, lists, bold/italic, blockquotes, links, tables).
- Produce `content.json` + `metadata.json` that render correctly through the **existing, unmodified** exporter section-walk — including **single-file** and **nav-only EPUB3** books.
- Extract embedded images to disk and reference them from the Markdown.
- Flow a single `book.epub` path through the whole pipeline.

## Non-goals

- No OCR/vision fallback. Fixed-layout/image-only "comic" EPUBs are out of scope this pass.
- No DRM handling (input assumed non-encrypted, owned).
- No re-architecting the exporters' section-walk; we adapt the **data** to its contract (only arg-parsing and one verify guard/tweak are added).
- PDF/audio exporters are not taught to embed images.

---

## Architecture

New module **`src/epub.ts`** mirrors `src/pdf.ts` (wraps the third-party lib behind a small typed interface; sole importer of the lib). A third branch is added to `transcribe-book-content.ts`'s `main()`; arg-parsing is added to both exporters' `main()`; one recognizer + one `isTrailer` tweak are added to `verify-book-content.ts`.

The unit of work is the **nav section** (see "Section model"), not the spine item.

### Libraries (new deps)

- **`epub2`** (`@3.0.2`) — zip container, OPF spine, manifest, NCX TOC, raw chapter XHTML, image binaries, **and raw file reads** (`getFileAsync`).
  - **Import:** **named** — `import { EPub } from 'epub2'`. A default import lacks `createAsync`/`*Async` (runtime-verified).
  - **Maintenance:** last published 2023-09; frozen-standard formats. Pulls `bluebird` + `adm-zip`; `createAsync` returns a Bluebird thenable — always `await`.
  - **API facts** (verified against shipped `.d.ts`/`.js` + runtime probes):
    - `EPub.createAsync(path)` → instance; rejects on parse error.
    - `instance.spine`/`instance.flow` — spine items as `TocElement` (`id`, `href`, `media-type`). **`linear` is NOT surfaced** (`parseSpine` never copies `itemref/@linear`).
    - `instance.manifest` — `{ [id]: { href, 'media-type', properties?, ... } }`; original OPF attributes (incl. `properties`) preserved; hrefs zip-root-relative.
    - `instance.metadata` — `{ creator?: string (single), title?, language?, publisher? }`.
    - **`instance.toc`** — **NCX-only**. `parseTOC` runs only when the OPF `<spine>` has a `toc=` attr; for **nav-only EPUB3** `instance.toc` is `[]` and `instance.ncx` is `undefined` (runtime-verified). NCX entries carry `href` with fragment preserved (e.g. `OEBPS/book.xhtml#c1`).
    - **`getFileAsync(id)`** → `[Buffer, mimeType]` — reads ANY manifest item's raw bytes by id. Used to read `nav.xhtml` (see Section model). (`instance.readFile`/`instance.zip.readFile` are fallbacks.)
    - **`getChapterRawAsync(id)`** → **unmodified** XHTML (fragment ids survive). Used instead of `getChapterAsync` (which rewrites `<img src>` and strips `<head>`).
    - **`getImageAsync(id)`** → `[Buffer, mimeType]`, keyed on manifest id, **rejects** (not null) on missing/non-image.
- **`node-html-markdown`** — pure-Node XHTML→Markdown, **no jsdom**; headings/lists/bold/italic/blockquote/links/GFM-tables + custom translators. `static translate(htmlString, opts?, customTranslators?)`. Returning `{ ignore: true }` from a custom `img` translator drops an image; a custom `h1..h6` translator reads the node level and emits a shifted/clamped prefix.
  - **Node:** `@2` needs `engines.node >= 20`. **Bump repo minimum to Node 20** (`package.json` + CI). Fallback: pin `@^1`.
  - **`node-html-parser@^6`** as a direct dep (matches nhm's copy; used for image pre-scan, leading-heading strip, anchor splitting). It has **no document-order range primitive** — the split algorithm below works on block-level siblings.

### `src/epub.ts` interface (sketch)

```ts
export interface EpubSpineItem { id: string; href: string; index: number }
export interface EpubNavEntry {
  title: string
  fileHref: string    // target spine file (fragment stripped, zip-root-relative)
  fragment?: string   // element id within the file, if present
  order: number       // assigned by the wrapper = index in the flattened walk (NOT epub2's unreliable `order`)
}
export interface EpubMetadata { title: string; authors: string[]; language?: string; publisher?: string }

export async function openEpub(epubPath: string): Promise<void>
export async function getEpubMetadata(epubPath: string): Promise<EpubMetadata>
export async function getEpubSpine(epubPath: string): Promise<EpubSpineItem[]>
export async function getEpubNav(epubPath: string): Promise<EpubNavEntry[]>   // NCX or manually-parsed nav.xhtml
export async function getEpubChapterHtml(epubPath: string, id: string): Promise<string>  // getChapterRawAsync
export async function getEpubImage(
  epubPath: string,
  resolvedHref: string   // zip-root-relative, normalized + zip-slip-checked by caller
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

### Obtaining nav entries (`getEpubNav`)

1. **NCX present** (`instance.toc.length > 0`): use it; split each `href` on `#` → `fileHref` + `fragment`.
2. **Otherwise (nav-only EPUB3):** find the manifest item whose `properties` (whitespace-split) contains `nav`; read its bytes with `getFileAsync(navId)`; parse with `node-html-parser`; select `<nav epub:type="toc">` (fall back to the first `<nav>`); flatten its `<ol><li><a href>` tree **depth-first**; for each `<a>`, resolve `href` against `dirname(navItem.href)`, zip-root-normalize, split on `#`. `order` = position in this walk.
3. Neither available → empty nav (every spine item becomes an orphan; see Section model).

---

## Section model

The exporter section-walk (`export-book-markdown.ts:290-316`, `export-book-pdf.ts:68-101`) requires, as **data**: `content[]` ordered by unique ascending `page`; `toc[]` whose `i`-th entry's `page` selects the `i`-th chunk; and a final terminator (it loops `i < toc.length - 1`). We satisfy this with an ordered list of **sections**, one chunk + one TOC entry each.

**Block-boundary helper.** A *split point* for a `fragment` is the **nearest block-level ancestor of the anchored element that is a direct child of the section container** (`<body>` or the chapter root). Block-level = `p,div,section,article,h1..h6,ul,ol,li,blockquote,table,figure,pre,hr`. This converts a possibly-inline, deeply-nested anchor (`<span id>` mid-paragraph) into a top-level sibling boundary, so segments are **whole-block sibling slices** (which node-html-parser can do via `body.childNodes`), never half-paragraphs. Degenerate case: an inline anchor directly under the container with no block ancestor → treat the hit as top-of-file (it then de-dups with the lead segment).

**Deriving sections (reading order):**

1. `navEntries = getEpubNav(...)`.
2. For each spine item `S` in order (raw XHTML via `getChapterRawAsync`, parsed with `node-html-parser`):
   - `hits` = nav entries with `fileHref === S.href`, ordered by the document position of each hit's split point (a no-fragment / top-of-file hit sorts first). **Duplicate or missing fragments:** a fragment whose element id is absent → split point = top-of-file; two hits resolving to the **same** split point are de-duplicated to the first (its title wins; the dropped title is logged — a known, warned limitation).
   - **≥1 fragment-bearing hits →** slice `S`'s top-level block children at the hits' split points. Each anchored segment → one **Section** (title via the rules below). The **lead segment** (blocks before the first split point) stays **within `S`**: if it has a leading heading → its own Section; else if it has substantive text → prepended to the **first anchored Section of `S`** (never merged across spine files); else dropped.
   - **Exactly one hit (no usable fragment) →** `S` is one Section.
   - **No hits (orphan) →** if `S` has a leading heading → its own Section (title from that heading); else `S` becomes its own `Section {n}`. (Orphans are always whole spine files, so they never merge across file boundaries — there is no in-file "previous section" to merge into. The only in-file merge is the *lead-segment* rule above, which stays within `S`.)
   - **Invariant:** every nav entry yields **exactly one** Section whose title defaults to that nav entry's title (unless a valid in-text heading overrides it). Nav-titled content is never merged away.
3. Each Section → `ContentChunk` (`page = ordinal`, `index = ordinal-1`) + `TocItem` (`page = ordinal`). Append a **trailing sentinel** `TocItem` (`page` undefined, `total` = section count) so the `toc.length-1` loop renders the real last section (its `nextPos` is undefined → `endIndex = content.length`). The sentinel is filtered from the printed TOC (only defined-position entries are listed, `:280-286`).

**Section title selection** (resolves the junk-heading CRITICAL):

- Candidate = the section's **in-text leading heading** (first `<h1>`–`<h6>` in document order). Promote it **only if** its normalized text content (tags/images/entities stripped, trimmed) **has length ≥ 2 and contains a letter or digit (`/[\p{L}\p{N}]/u`).** This accepts real titles including purely-numeric ones ("1984", "42", "1: The Beginning") and rejects single-char drop-caps ("P"), image-only headings (empty text), and punctuation/whitespace-only headings ("—", "***", ""). (A ≥2-char roman/part-number like "II" passes; that is far more often a real chapter label than noise, and the nav-title fallback covers the ambiguous case — noted in Known limitations.)
- Else the **nav title** for this section.
- Else `Section {n}`.
- When (and only when) the in-text heading was promoted, set `stripLeadingHeading` so the body doesn't repeat it.

**Idempotency key:** `screenshot = epub:<sectionKey>`, `sectionKey = <spineId>` or `<spineId>#<fragment>` for split sections — stable, unique, mirrors `pdf:<path>#page=N`. Reuses `processedScreenshots` skip (`:479-484`). **`FORCE` is not implemented in transcribe**; re-transcribe means deleting `content.json`.

**Documented limitation:** nav hierarchy flattened to one section level; out-of-document-order nav trees render in physical reading order (printed TOC and content stay mutually consistent because both derive from the same `toc[]`); duplicate-fragment nav entries drop the later title (warned).

---

## Mapping to existing types

### ContentChunk (per section)

| field | value |
|---|---|
| `index` | 0-based section ordinal |
| `page` | ordinal (1-based, contiguous, unique) |
| `text` | section Markdown, or `[BLANK_PAGE]` only when the section Markdown (incl. image refs) is empty |
| `screenshot` | `epub:<sectionKey>` |

### metadata.json (`BookMetadata`)

- `meta.title` = first `dc:title`; `meta.authorList` = `creator ? [creator] : []`; `meta.language`/`publisher` when present.
- `meta` has **16 required fields** (`types.ts:22-43`); concrete default factory (exporters read only `title`+`authorList`): empty strings for `ACR/asin/bookSize/bookType/cover/publisher/refEmId/releaseDate/version`, `sample:false`, `positions:{cover:0,srl:0,toc:0}`, `startPosition:0`, `endPosition:` section count, plus `title/authorList/language`.
- `pages` — one `PageChunk{index,page,total,screenshot}` per section; `total` = section count.
- `toc` — per-section `TocItem{title,page,total}` (`location` undefined → page mode, `:251-257`) + trailing sentinel `{title:'',page:undefined,total}`.

**Fields each exporter reads** (verified): markdown → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`, `toc[].location`; pdf → `meta.title`, `meta.authorList`, `toc[].title`, `toc[].page`. Defaults are safe.

---

## Heading reconciliation

The exporter injects `## <toc title>` per section. To avoid a duplicate, the promoted title is **always stripped from the body**:

1. **Title precedence** — as in Section model (in-text leading heading *passing the junk-guard* → nav title → `Section {n}`).
2. **Strip** — when `stripLeadingHeading` is set, remove the promoted heading node before conversion.
3. **Demote with clamp (needs the pre-pass):** the `node-html-parser` pre-scan computes the section's **minimum remaining heading level** `m`; the custom `h1..h6` translator emits `min(6, level + (3 - m))` so the shallowest remaining heading becomes `h3` (under the exporter's `h2`). Relative depth preserved **up to h6**; deeper levels clamp/merge (rare; acknowledged).

---

## Image extraction

- Raw XHTML via `getChapterRawAsync`; pre-scan `<img>` with `node-html-parser`. The `img` translator checks the `src` scheme **before** calling `resolveImage`:
  - **`data:` URI** → passed through untouched. **SVG-wrapped `<image xlink:href>`, `srcset`** out of scope v1 (documented); text unaffected.
  - Otherwise: resolve `src` against `dirname(spineItem.href)`, normalize `.`/`..` to **zip-root-relative**; **reject (drop + warn) any path escaping the zip root** (zip-slip). Manifest lookup (href→id) → `getEpubImage`.
- **Filename + memoization:** keep a `Map<manifestId, finalName>`. On the **first** encounter of an id: name = `sanitizeDirname(manifest id)` + extension **derived from the media-type** (`image/jpeg`→`.jpg`, `image/png`→`.png`, …; fall back to the href extension only when media-type is generic/unknown); because `sanitizeDirname` is lossy (strips chars, truncates to 128) distinct ids can collide, so **disambiguate against a `Set` of already-emitted names** (append `-2`, `-3`, … deterministically by first-seen order), add to the Set, and store in the Map. On **every subsequent** encounter of the **same id** (e.g. one cover image referenced from two sections): return the memoized name and do **not** re-disambiguate or re-emit — one source image is always one file. The chosen name is used for **both** the on-disk file (`out/<book>/images/<name>`) and the Markdown `src` (`images/<name>`), so they always agree. Before writing, assert the resolved target is contained within `out/<book>/images/`.
- On miss/unreadable/non-image/rejection → `resolveImage` returns `null`, `<img>` dropped, text kept, warn. Never abort the section.
- **Cover/image-only/text-light sections:** convert first (image refs included); `[BLANK_PAGE]` only if the result is empty.

---

## Links & encoding contract

- **Link handling order:** image rewrite runs first/independently; link handling then **unwraps the `<a>` element, keeping its child nodes** (so `<a href><img></a>` keeps the image, and an anchor wrapping text keeps the text) — it does **not** text-extract.
- **Which links are unwrapped (intra-EPUB):** parse the `href`. Preserve if the scheme ∈ {`http`,`https`,`mailto`,`tel`}. Otherwise (bare `#fragment`; relative path; `epub:`; or a path that resolves to a manifest/spine file) → **unwrap** (drop the dead-in-combined-output link, keep children). Unknown/other schemes → unwrap (safe default; no dead links in the single combined Markdown).
- Bytes read UTF-8; HTML entities decoded; `&nbsp;`/`&#160;` → space; `&shy;` removed; `<pre>` → fenced code; insignificant inter-tag whitespace collapsed.
- EPUB chunks are 1:1 with sections (no multi-screen overlap), so `joinChunksDedupingOverlap` (`:26`) is effectively a no-op for EPUB output.

---

## Pipeline ergonomics

`.epub` detection added to three `main()`s so one `book.epub` flows end-to-end:

- `transcribe-book-content.ts` — `isEpubMode = /\.epub$/i.test(arg)`; `out/<base>` via `sanitizeDirname(path.basename(epubPath, path.extname(epubPath)))` (as PDF branch, `:424`).
- `export-book-markdown.ts` — extend the existing `.pdf` arg test (`:336-356`) to accept `.epub`; Kindle mode renders automatically.
- `export-book-pdf.ts` — **add `main()` arg-parsing** (none today; `:12-16` hardwired to `ASIN`), mirroring markdown: `.pdf`/`.epub` → `out/<basename>`; else `path.resolve(arg)`; else `ASIN`. (PDF export stays metadata-only — no content-only fallback — which is fine since EPUB always writes `metadata.json`.)

---

## verify-book-content compatibility (two changes)

1. **`epub:` keys** — `parseScreenshotFilename` (utils.ts:69, `\d+-\d+\.png` only) and `parsePdfRef` both return null for `epub:<…>`, so every EPUB chunk would be flagged `unparseable-screenshot` (CLI sets `exitCode=1`). **Add `EPUB_REF_RE = /^epub:.+$/`** as a third recognizer in that branch (`:173-197`). (`.+` matches keys with `#`, verified.)
2. **Section-4 chapter-coverage `isTrailer`** (`:391-421`, runs whenever `metadata.json` exists). Section 4 evaluates only numeric-`page` entries (`:393`); interior 1-page sections are skipped by the `nextPage - item.page <= 1` guard (`:408`), so only the **last** section is checked. The current `isTrailer = !finite(nextPage) && i === toc.length - 1` (`:399`) is defeated by our sentinel (the real last section sits at `toc.length-2`), so a `[BLANK_PAGE]` final section would raise `empty-chapter`. **Change the index check to the last entry with a numeric `page`** (`i === lastIndexWithNumericPage(toc)`, where `lastIndexWithNumericPage` = the highest index `i` with `typeof toc[i].page === 'number'`). This is behavior-preserving for non-EPUB: Section 4 only ever evaluates numeric-page entries, so where location-only entries trail (some Kindle back-matter) the change merely suppresses a trailer false-positive the existing comment already wants gone — it never introduces one or hides a real multi-page blank chapter. For PDF it's inert (PDF writes no `metadata.json`).

Other verify checks are inert for EPUB: `duplicate-screenshot` (unique keys), orphan/missing-screenshot (gated on PNGs in `pages/`), PDF coverage (`parsePdfRef` null).

---

## Error handling & edge cases

- Malformed/missing OPF spine, unreadable zip → fail fast with a clear message (mirrors `assert(numPages > 0)`).
- Empty section Markdown → `[BLANK_PAGE]`.
- Image miss/unreadable/zip-slip/non-image → drop image, keep text, warn.
- No NCX **and** no nav → every spine item is an orphan → one section per spine file (titled from its leading heading, else `Section {n}`); `metadata.json` still emitted (never content-only mode, whose `formatPdfTextToMarkdown` would mangle real Markdown). A pathological one-paragraph-per-spine-file EPUB therefore yields many tiny sections — accepted (correct, if noisy) rather than merged across files, which would misattribute content; see Known limitations.
- TOC anchor-slug collisions for duplicate/empty titles — pre-existing exporter behavior (`:284`); the junk-guard above prevents v3-induced empty-title collisions, but genuinely duplicate real titles remain a **documented known limitation**.
- **Sentinel coupling caveat:** the trailing sentinel is load-bearing; a future exporter refactor that "fixes" the `toc.length-1` off-by-one would make the sentinel render as an empty section.

---

## Testing

Target ≥80% on `src/epub.ts` + `sectionHtmlToMarkdown`.

- **Fixtures (two committed EPUBs, sources under `src/__tests__/fixtures/`):**
  - **(A) single XHTML file, 3 chapters via `#frag` nav anchors, with an NCX** — exercises anchor splitting (incl. one anchor on a `<span>` mid-paragraph to test block-boundary promotion), an orphan front-matter file with no nav entry, one referenced image, an intra-book footnote link, and a **text-rich final section** (keeps Section-4 green).
  - **(B) nav-only EPUB3, NO NCX, NO `<spine toc>`** — asserts `epub2.toc` is empty and the wrapper's manual `nav.xhtml` parse (`properties="nav"` + `getFileAsync`) yields the right sections.
  - Helper `buildFixtureEpub()` zips sources at runtime with **`jszip`** (devDep), `mimetype` **first and STORED**.
- **`src/epub.ts` unit tests:** spine order; NCX vs nav-only nav extraction; anchor-aware split incl. mid-paragraph `<span>` (block promotion) and missing/duplicate fragments; orphan handling (one section per orphan spine file; nav-titled short file keeps its own section) and the lead-segment in-file merge; trailing sentinel; href→id image resolution + **zip-slip rejection** + sanitize-collision disambiguation + media-type extension; single-creator → `authorList`.
- **`sectionHtmlToMarkdown` unit tests:** heading/list/emphasis/blockquote/table preservation; **junk-guard** (drop-cap/part-number/image-only/empty heading → nav title fallback); leading-title promote+strip (no duplicate); demote-to-h3 + h6 clamp; image rewrite + drop-on-null + **data-URI pass-through**; `<a><img></a>` keeps image; intra-EPUB link unwrap vs external-link retention; `&nbsp;`/`&shy;` normalization.
- **Integration test (both fixtures):** run the EPUB branch end-to-end; assert `content.json` (section count, ordering, `epub:` keys, cover keeps image ref not `[BLANK_PAGE]`) and `metadata.json` (`toc` = sections + 1 sentinel, `pages`, title/authors). Then run `verifyBookContent` and assert **zero `unparseable-screenshot` AND zero `empty-chapter`** issues.

---

## Files touched

| File | Change |
|---|---|
| `src/epub.ts` | **new** — wrapper (`{ EPub }`, `getChapterRawAsync`, NCX + manual nav.xhtml via `getFileAsync`/`properties="nav"`, href→id image map, zip-slip + sanitize-collision guards) + section derivation + `sectionHtmlToMarkdown` |
| `src/transcribe-book-content.ts` | new EPUB branch in `main()`; `.epub` detection |
| `src/export-book-markdown.ts` | extend arg detection to `.epub` |
| `src/export-book-pdf.ts` | **add `main()` arg-parsing** (none today) |
| `src/verify-book-content.ts` | add `EPUB_REF_RE`; fix `isTrailer` to last numeric-page entry |
| `src/__tests__/epub.test.ts` | **new** — unit + integration tests |
| `src/__tests__/fixtures/**` | **new** — fixture sources (single-file+NCX, nav-only EPUB3) |
| `src/__tests__/helpers/build-fixture-epub.ts` | **new** — `jszip` fixture zipper (mimetype first/STORED) |
| `package.json` | add `epub2`, `node-html-markdown`, `node-html-parser@^6` deps + `jszip` devDep; bump `engines.node` to `>=20` |
| `.github/workflows/*` | bump CI Node matrix to 20 |
| `CLAUDE.md` | document the EPUB workflow alongside PDF |

## Known limitations (intended, documented)

- Nav hierarchy flattened to one section level; duplicate-fragment nav entries drop the later title (warned).
- Out-of-document-order nav trees render in physical reading order.
- Multi-author EPUBs collapse to a single `creator` string (epub2).
- SVG-wrapped/`srcset`/data-URI images not extracted in v1 (data-URIs passed through).
- Intra-EPUB hyperlinks unwrapped to their children (footnote *content* preserved as orphan sections).
- Genuinely duplicate/empty real TOC titles can collide in exporter anchor slugs (pre-existing exporter behavior).
- Section title may differ from the nav label when a valid in-text heading is present (intentional, avoids double headings).
- A pathological EPUB with no nav and one paragraph per spine file produces one (tiny) section per file rather than merging — chosen to never misattribute content across files.
- A ≥2-char roman/part-number in-text heading ("II") is promoted as a title; the nav-title fallback covers cases where it is a structural label rather than a real title.
