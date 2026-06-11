# Book Metadata Recovery

How the pipeline captures a book's title/author/page-totals from Amazon, why
that capture is fragile, and the layered recovery that keeps a fully transcribed
book exportable even when capture fails.

## Background

`out/<asin>/metadata.json` holds two objects the exporters and pipeline need:

- **`info`** — from Amazon's `…/service/mobile/reader/startReading?asin=…`
  response (also carries `metadataUrl`).
- **`meta`** — from the `…/YJmetadata.jsonp` response (book `title`,
  `authorList`, page totals, positions).

`extract-kindle-book.ts` captures both **passively**: a `page.on('response')`
listener snoops those two responses while the Kindle web reader has the book
open.

The exporters (`export-book-markdown.ts`, `-pdf.ts`, `-audio.ts`) only read
**`meta.title`** and **`meta.authorList`** — so a missing `meta` is two missing
strings, and must never block exporting a fully transcribed book.

## Symptom

```
❌ Markdown export failed: invalid book metadata: missing meta
```

…with a `metadata.json` that has `toc` and `pages` but no `meta`/`info`.

## Root causes (both real, observed)

1. **Warm-profile service-worker cache miss.** The extractor reuses a persistent
   Chromium profile (`out/<asin>/data`). On a warm profile the Kindle reader
   restores from its **service-worker cache** and never re-requests
   `startReading` / `YJmetadata` over the network — so the passive listener sees
   nothing and `metadata.json` is written without `meta`/`info`.
2. **403 on synthetic replay.** Replaying the request ourselves with Playwright's
   `page.request` (a Node-side HTTP client) returns **HTTP 403** — Amazon's
   anti-bot rejects it because it lacks the reader's `User-Agent` / `Referer` /
   `sec-fetch-*` headers. An in-page `fetch` (via `page.evaluate`) is closer but
   has also been observed to 403.

A consequence: the extractor's "already extracted?" check must **not** treat a
book as complete when `meta`/`info` are missing (`hasBookMeta` in
`extract-kindle-book.ts`), or it would short-circuit forever and never recover.
When pages are complete but metadata is missing, it relaunches the reader
(existing screenshots are skipped, so this is cheap).

## Recovery chain

Each layer catches the previous layer's failure:

| # | Layer | Where | Notes |
|---|-------|-------|-------|
| 1 | **Passive capture** | `extract-kindle-book.ts` `page.on('response')` | The happy path. |
| 2 | **Cache-bust reload** | `forceReaderMetadataRefresh()` | Unregister the service worker + clear Cache Storage + disable the HTTP cache (CDP `Network.setCacheDisabled`), then reload so the reader issues its **own** authenticated request — no 403 — and the passive listener catches the 200. Cache is re-enabled afterward. **Preferred root-cause fix.** |
| 3 | **Direct fetch** | `recover-book-metadata.ts` | Replay `startReading` + `metadataUrl` via in-page fetch, falling back to `page.request` for a cross-origin `metadataUrl`. |
| 4 | **Title-page OCR** | `title-page-meta.ts`, invoked from `transcribe-book-content.ts` | When `meta.title` is missing, gpt-4o reads the title/author off the title-page screenshots and backfills via `setBookMeta()`. **Account-independent; needs OpenAI credits.** Prefers the dedicated `metadata.frontMatter` shots (Kindle) and falls back to the first few content pages (PDF/EPUB). |
| 5 | **Out-dir fallback** | `resolveBookMeta()` in `book-meta.ts` | Exporters derive a title from the `<asin>-<title>` out-dir (or bare dir) and **warn** instead of asserting and dying. |
| 6 | **Manual** | `set-book-meta.ts` CLI | `pnpm tsx src/set-book-meta.ts <asin> "<title>" "<author[,author2]>"` |

## Manual recovery

If automated recovery didn't run (e.g. no OpenAI credits for layer 4), set the
title/author directly:

```bash
pnpm tsx src/set-book-meta.ts <asin> "On Writing Well" "William Zinsser"
# or target an explicit out dir:
pnpm tsx src/set-book-meta.ts out/<asin> "<title>" "<author[,author2]>"
```

Then re-run the export. (The export also works without this — it falls back to
the out-dir name as the title.)

## Testing notes

- Layers **2 and 3** drive a live, authenticated browser and **cannot be
  unit-tested** — verify them on a real extraction run.
- The orchestration of layers **3–5** is deliberately split into pure modules
  over **injectable** fetchers / extractors / image loaders, and is covered by:
  - `src/__tests__/recover-book-metadata.test.ts`
  - `src/__tests__/title-page-meta.test.ts`
  - `src/__tests__/book-meta.test.ts`
  - `src/__tests__/set-book-meta.test.ts`

## Field notes (live runs)

Observed across two accounts/books (`B0090RVGW0`, `B0BZ7QZQJ6`):

- **The metadata API path is effectively dead for these accounts.** `startReading`
  returns **HTTP 403** even on a cold profile and even via in-page fetch, and the
  reader never surfaces `startReading`/`YJmetadata` to the passive listener — so
  layers 1–3 do not recover anything here. Layer 2 (cache-bust) is still the best
  shot in principle but did not change the outcome on these runs.
- **Layer 4 needed front matter that the Kindle loop skips.** The main content
  loop begins at the first page-numbered TOC entry (`firstPageTocItem`), so a
  book whose front matter (Cover, Title Page, Copyright) sits at *locations*
  before the first *page* never had its title page screenshotted. **Fixed:**
  `extract-kindle-book.ts` now does a best-effort front-matter capture pass —
  it navigates to the Title Page / Cover / Copyright TOC entries, screenshots
  them to `out/<asin>/front-matter/`, and records them in `metadata.frontMatter`.
  Layer 4 prefers those shots. (Best-effort + wrapped: any failure falls back to
  prior behavior. Verify on a live run.)
- **Known remaining gap — front-matter *content* (incl. chapter 1).** A
  location-only first chapter that sits before the first page-numbered entry is
  still skipped by the main content loop, and the page-keyed exporter would drop
  it even if captured. Recovering that body text needs a coordinated
  extraction + export change (handle the location→page transition) and a live
  run to verify; not yet done.
- **Net:** `set-book-meta` (layer 6) remains the guaranteed fallback. With the
  front-matter capture, layer 4 should now auto-fill the Kindle title in the
  common case.

## Logging gotcha

`setupTimestampedLogger()` (utils.ts) redirects `console.*` to
`out/<asin>/logs/<timestamp>.log`; the terminal stays quiet apart from the
progress bar. Recovery diagnostics therefore land in that log file, **not** the
terminal. Top-level fatal errors use `reportFatalError()` (utils.ts), which
writes synchronously to the real stderr (fd 2) so failures are still visible and
survive `process.exit()`.
