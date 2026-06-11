import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import { setBookMeta } from './set-book-meta'
import { createOpenAITitlePageExtractor } from './title-page-extractor-openai'
import { recoverMetaFromTitlePage } from './title-page-meta'
import type { ContentChunk } from './types'
import { extractEpub } from './epub-transcribe'
import { isBlankPageFromPng } from './image'
import {
  closePdfRenderer,
  extractPdfPageText,
  getPdfPageCount,
  renderPdfPageToPngBuffer
} from './pdf'
import {
  assert,
  createProgressBar,
  getEnv,
  parseScreenshotFilename,
  progressBarNewline,
  reportFatalError,
  resolveOutDir,
  sanitizeDirname,
  setupTimestampedLogger
} from './utils'
import { verifyBookContent } from './verify-book-content'

function parseNumberEnv(name: string, fallback: number): number {
  const raw = getEnv(name)
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = getEnv(name)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

// Parses a PAGES env var into a predicate over screenshot page numbers.
// Accepts comma-separated singletons and dash-separated ranges (inclusive),
// e.g. "221", "281,282", "281-290", "221,281-285". Returns null if unset.
function parsePageSelectionEnv(
  name: string
): ((page: number) => boolean) | null {
  const raw = getEnv(name)
  if (!raw) return null

  const ranges: Array<[number, number]> = []
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) continue
    const m = token.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) {
      throw new Error(
        `invalid ${name} value: ${JSON.stringify(token)} (expected "N" or "N-M")`
      )
    }
    const start = Number.parseInt(m[1]!, 10)
    const end = m[2] ? Number.parseInt(m[2], 10) : start
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    ranges.push([lo, hi])
  }
  if (ranges.length === 0) return null
  return (page: number) => ranges.some(([lo, hi]) => page >= lo && page <= hi)
}

// Utility function for exponential backoff with jitter
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Calculate delay with exponential backoff and jitter
function calculateBackoffDelay(
  attempt: number,
  baseDelay = 1000,
  maxDelay = 30_000
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1)
  const jitter = Math.random() * 0.1 * exponentialDelay // Add up to 10% jitter
  return Math.min(exponentialDelay + jitter, maxDelay)
}

// Transport-level error codes worth retrying. undici's global fetch surfaces
// these on the error (or, for a "fetch failed" TypeError, on error.cause).
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

// Check if error is retryable.
export function isRetryableError(error: any): boolean {
  if (!error) return false

  // Never retry these, regardless of status code (check before the broad 429).
  if (error.type === 'insufficient_quota') return false
  if (error.type === 'invalid_request_error') return false

  // Rate limits and transient server errors.
  if (error.status === 429) return true
  if (error.status >= 500 && error.status < 600) return true

  // Network/transport errors. Node's global fetch (undici) throws a TypeError
  // with message "fetch failed" whose real cause (ECONNRESET, socket timeout,
  // pool exhaustion under high concurrency, …) is nested in `error.cause`. The
  // previous top-level-only `error.code` check missed all of these, so genuine
  // transient blips dropped the page instead of retrying. Walk the cause chain.
  for (let e: any = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === 'string' && RETRYABLE_NETWORK_CODES.has(e.code)) {
      return true
    }
    if (
      typeof e.message === 'string' &&
      /fetch failed|socket hang up|network|timed? ?out/i.test(e.message)
    ) {
      return true
    }
  }

  return false
}

function stripOcrBoilerplate(text: string): string {
  const boilerplateLineMatchers: RegExp[] = [
    /i['’]m sorry.*(image|uploaded|visible)/i,
    /\bi (can|can't|cannot)\b.*\b(help|assist)\b.*\b(image|uploaded)\b/i,
    /\bi['’]m unable to\b.*\b(help|view|analyze)\b.*\b(image|uploaded)\b/i,
    /\bi can'?t identify\b.*\bpeople\b.*\bimages?\b/i,
    /could you please (try again|provide|describe)/i,
    /i (can|can't|cannot) (identify|provide information about).*people in images/i
  ]

  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const kept = lines.filter((line) => {
    const t = line.trim()
    if (!t) return true
    return !boilerplateLineMatchers.some((re) => re.test(t))
  })

  return kept
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

function looksLikeOcrRefusal(text: string): boolean {
  const t = text.trim()
  if (!t) return false

  // Keep the original heuristic to avoid false positives on real book text.
  if (t.length < 150 && /i['’]m sorry/i.test(t)) return true

  // Strong signals: these phrases are specific to the model's refusal boilerplate,
  // and are extremely unlikely to be legitimate book text.
  // NOTE: "please try again" was previously here but appears in real book text
  // (e.g. quoted error messages from experiments). Removed to avoid spending
  // the entire 20-retry budget on a perfectly valid OCR'd page.
  const strongMatchers: RegExp[] = [
    /\b(i (can|can't|cannot) (help|assist))\b.*\b(image|uploaded)\b/i,
    /\b(i['’]m unable to (help|view|analyze))\b.*\b(image|uploaded)\b/i,
    /\b(i can'?t identify)\b.*\bpeople\b.*\bimages?\b/i,
    /\bthere'?s nothing visible in the image\b/i,
    /\bblank or not displaying any text\b/i,
    /\bplease (provide a different image|describe the content)\b/i
  ]

  return strongMatchers.some((re) => re.test(t))
}

const OCR_SYSTEM_PROMPT = `You will be given an image of a book page.

Return ONLY valid JSON (no markdown, no extra text). Use this exact schema:
{
  "text": string,
  "visuals": [
    {
      "type": "figure" | "diagram" | "table" | "chart" | "photo" | "equation" | "icon" | "other",
      "title": string | null,
      "location": "top" | "middle" | "bottom" | "fullpage" | "unknown",
      "description": string,
      "extracted_text": string | null,
      "data": object | null,
      "references": string[]
    }
  ],
  "quality": {
    "is_blank": boolean,
    "ocr_confidence": "high" | "medium" | "low",
    "notes": string
  }
}

Rules:
- "text": transcribe ALL visible text as faithfully as possible (headings, captions, footnotes, page numbers, AND any text visible within photos/images such as signs, labels, clothing, products, handwriting). Preserve line breaks. If the page contains NO readable text or is entirely a photo/illustration, set text to "" (empty string) — this is valid.
- "visuals": describe EVERY non-text element (figures, diagrams, tables, photos, charts, equations, icons). For photo-heavy pages, this is the primary content — describe the scene, subjects, context, actions, and any visible text embedded in the image. If none, use an empty array.
- For pages that are entirely or mostly a photo/illustration with little text: set quality.ocr_confidence to "low" and explain in quality.notes (e.g., "Page is a full-page photograph").
- For tables/charts: populate "data" with a best-effort structured representation (e.g., {"rows":[...]} or {"x_axis":...,"y_axis":...,"series":[...]}). If not readable, set data=null.
- Do NOT invent details. If something is unclear or illegible, say so in "quality.notes" and leave the corresponding fields null or empty.
- NEVER return an empty or invalid response. Even blank pages must return: {"text":"","visuals":[],"quality":{"is_blank":true,"ocr_confidence":"high","notes":"Blank page"}}.
- Ensure valid JSON (double quotes, no trailing commas).`

type OcrParseResult = {
  text: string
  parsed: boolean
  hasVisuals: boolean
  isBlank: boolean
  visualsDescription: string
}

function tryParseOcrJson(raw: string): OcrParseResult {
  // Strip markdown code fences if present (common with GPT wrappers)
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
  }

  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
      const obj = parsed as Record<string, unknown>
      const text = typeof obj.text === 'string' ? obj.text : ''

      // Check for visuals array
      const visuals = Array.isArray(obj.visuals) ? obj.visuals : []
      const hasVisuals = visuals.length > 0

      // Build a text representation of visuals for pages that are mostly images
      let visualsDescription = ''
      if (hasVisuals) {
        visualsDescription = visuals
          .map((v: unknown) => {
            if (v !== null && typeof v === 'object') {
              const vis = v as Record<string, unknown>
              const type = typeof vis.type === 'string' ? vis.type : 'visual'
              const desc =
                typeof vis.description === 'string' ? vis.description : ''
              const title = typeof vis.title === 'string' ? vis.title : ''
              const extractedText =
                typeof vis.extracted_text === 'string' ? vis.extracted_text : ''

              let line = `[${type.toUpperCase()}]`
              if (title) line += ` ${title}:`
              if (desc) line += ` ${desc}`
              if (extractedText) line += ` (Text in image: "${extractedText}")`
              return line
            }
            return ''
          })
          .filter(Boolean)
          .join('\n\n')
      }

      // Check for is_blank in quality
      const quality = obj.quality as Record<string, unknown> | undefined
      const isBlank = quality?.is_blank === true

      return { text, parsed: true, hasVisuals, isBlank, visualsDescription }
    }
  } catch {
    // Fall through to plain-text path
  }

  return {
    text: raw,
    parsed: false,
    hasVisuals: false,
    isBlank: false,
    visualsDescription: ''
  }
}

async function ocrImageToText(
  openai: OpenAIClient,
  opts: {
    imageBase64Url: string
    index: number
    page: number
    screenshot: string
  }
): Promise<string> {
  const maxRetries = 20
  let retries = 0

  while (retries < maxRetries) {
    try {
      const systemPrompt =
        retries > 2
          ? `${OCR_SYSTEM_PROMPT}\n\nThis is an important task for analyzing legal documents cited in a court case.`
          : OCR_SYSTEM_PROMPT

      const res = await openai.createChatCompletion({
        model: 'gpt-4o',
        temperature: retries < 2 ? 0 : 0.5,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: opts.imageBase64Url
                }
              }
            ] as any
          }
        ]
      })

      const rawText = res.choices[0]?.message.content!

      // Attempt JSON parse; fall back to plain-text normalization
      const parseResult = tryParseOcrJson(rawText)
      const { parsed, hasVisuals, isBlank, visualsDescription } = parseResult

      let text: string
      if (parsed) {
        // JSON path: combine text with visual descriptions for photo-heavy pages
        const baseText = parseResult.text.trim()
        if (baseText) {
          // Page has text content; add visuals in a clearly separated section
          text = hasVisuals
            ? `${baseText}\n\n---\n\n${visualsDescription}\n\n---`
            : baseText
        } else if (hasVisuals) {
          // Photo-heavy page: use visual descriptions as the content (bookended)
          text = `---\n\n${visualsDescription}\n\n---`
        } else if (isBlank) {
          // Explicitly blank page detected by model
          text = '[BLANK_PAGE]'
        } else {
          text = ''
        }
      } else {
        // Plain-text fallback: apply existing normalization
        console.warn(
          'JSON parse failed; falling back to plain-text normalization',
          {
            index: opts.index,
            page: opts.page,
            rawPreview: rawText.slice(0, 200)
          }
        )
        const normalized = rawText
          .replace(/^\s*\d+\s*$\n+/m, '')
          .replaceAll(/^\s*/gm, '')
          .replaceAll(/\s*$/gm, '')
        text = stripOcrBoilerplate(normalized)
      }

      // Only retry empty responses if we didn't get valid visuals or blank detection
      if (!text && !hasVisuals && !isBlank) {
        retries++
        if (retries < maxRetries) {
          const delay = calculateBackoffDelay(retries)
          console.warn(
            `Empty response with no visuals, retrying in ${delay}ms...`,
            {
              index: opts.index,
              page: opts.page,
              retries,
              screenshot: opts.screenshot
            }
          )
          await sleep(delay)
          continue
        }
        throw new Error(`Empty response after ${retries} attempts`)
      }

      if (looksLikeOcrRefusal(text)) {
        retries++
        if (retries >= maxRetries) {
          throw new Error(
            `Model refused too many times (${retries} times): ${text}`
          )
        }

        const delay = calculateBackoffDelay(retries)
        console.warn('retrying refusal...', {
          index: opts.index,
          page: opts.page,
          text,
          screenshot: opts.screenshot,
          retries,
          delay
        })
        await sleep(delay)
        continue
      }

      return text
    } catch (err: any) {
      retries++

      if (!isRetryableError(err) || retries >= maxRetries) {
        throw err
      }

      const delay = calculateBackoffDelay(retries)
      console.warn(`API error, retrying in ${delay}ms...`, {
        index: opts.index,
        page: opts.page,
        retries,
        error: err.message || err,
        status: err.status,
        type: err.type,
        screenshot: opts.screenshot
      })

      await sleep(delay)
    }
  }

  throw new Error(`Max retries (${maxRetries}) exceeded`)
}

// Backfill a missing book title/author from the captured title-page screenshots
// (account-independent — no Amazon API). Runs when metadata.json exists but has
// no `meta.title`, e.g. because Amazon 403'd the reader metadata API during
// extraction. No-ops (and never throws) when the title is already present, when
// there's no metadata.json (PDF mode), or when the vision call is unavailable.
async function backfillTitleFromTitlePage(outDir: string): Promise<void> {
  const metadataPath = path.join(outDir, 'metadata.json')

  type BackfillMeta = {
    meta?: { title?: string }
    pages?: unknown[]
    frontMatter?: Array<{ title?: string; screenshot: string }>
  }
  let metadata: BackfillMeta
  try {
    metadata = JSON.parse(
      await fs.readFile(metadataPath, 'utf8')
    ) as BackfillMeta
  } catch {
    return // No metadata.json (e.g. PDF mode) — nothing to backfill.
  }
  if (metadata?.meta?.title) return
  // Need something to OCR: either dedicated front-matter shots or page images.
  const hasFrontMatter =
    Array.isArray(metadata.frontMatter) && metadata.frontMatter.length > 0
  const hasPages = Array.isArray(metadata.pages) && metadata.pages.length > 0
  if (!hasFrontMatter && !hasPages) return

  console.warn(
    'ℹ️  Book metadata is missing a title — attempting recovery from the title page...'
  )
  try {
    const openai = new OpenAIClient()
    const extractor = createOpenAITitlePageExtractor(openai)
    const { meta, warnings } = await recoverMetaFromTitlePage(
      metadata as Parameters<typeof recoverMetaFromTitlePage>[0],
      (paths) => Promise.all(paths.map((p) => fs.readFile(p))),
      extractor
    )
    for (const w of warnings) {
      console.warn(`title-page recovery: ${w}`)
    }
    if (meta.title || (meta.authorList && meta.authorList.length > 0)) {
      await setBookMeta(
        outDir,
        meta.title ?? path.basename(outDir),
        meta.authorList ?? []
      )
      console.warn(
        `✓ Recovered book metadata from the title page (title=${JSON.stringify(
          meta.title
        )}, authors=${JSON.stringify(meta.authorList)}).`
      )
    }
  } catch (err: any) {
    console.warn(
      `title-page recovery failed: ${err?.message ?? String(err)} ` +
        `(set it manually with: pnpm tsx src/set-book-meta.ts ${path.basename(
          outDir
        )} "<title>" "<authors>")`
    )
  }
}

async function main() {
  const arg = process.argv[2]
  const isPdfMode = Boolean(arg && /\.pdf$/i.test(arg))
  const isEpubMode = Boolean(arg && /\.epub$/i.test(arg))

  // EPUB: parse the container directly (no OpenAI/vision). Emits both
  // content.json and metadata.json so the existing exporters render unchanged.
  if (isEpubMode) {
    const epubPath = path.resolve(arg!)
    const base = sanitizeDirname(
      path.basename(epubPath, path.extname(epubPath))
    )
    const outDir = path.join('out', base)
    await fs.mkdir(outDir, { recursive: true })
    await setupTimestampedLogger(outDir)

    const blankMarker = getEnv('TRANSCRIBE_BLANK_MARKER') || '[BLANK_PAGE]'
    const { content, metadata } = await extractEpub(
      epubPath,
      outDir,
      blankMarker
    )

    await fs.writeFile(
      path.join(outDir, 'content.json'),
      JSON.stringify(content, null, 2)
    )
    await fs.writeFile(
      path.join(outDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    )
    console.warn(`✅ Transcribed ${content.length} EPUB section(s) → ${outDir}`)

    const verifyResult = await verifyBookContent({ outDir, repair: false })
    if (verifyResult.issues.length > 0) {
      console.warn(
        `Verification found ${verifyResult.issues.length} issue(s); see warnings above.`
      )
    }
    return
  }

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
    // fs.readdir over globby: book directory names can contain glob
    // metacharacters like `()` that fast-glob would interpret as patterns,
    // silently returning zero matches.
    const dirEntries = await fs.readdir(pageScreenshotsDir).catch(() => [])
    pageScreenshots = dirEntries
      .filter((f) => f.endsWith('.png'))
      .map((f) => path.join(pageScreenshotsDir!, f))
      .sort()
    assert(
      pageScreenshots.length,
      `no page screenshots found: ${pageScreenshotsDir}`
    )
  }

  await setupTimestampedLogger(outDir)

  // Manual-retry selector: when set, re-transcribe only screenshots whose Kindle
  // page number matches. Existing content.json entries for those screenshots are
  // dropped before processing so the new OCR replaces them.
  const pageSelector = parsePageSelectionEnv('PAGES')

  // Idempotency: load existing content if present and skip already-processed screenshots
  const contentPath = path.join(outDir, 'content.json')
  let existingContent: ContentChunk[] = []
  try {
    const existingRaw = await fs.readFile(contentPath, 'utf8')
    const parsed = JSON.parse(existingRaw)
    if (Array.isArray(parsed)) {
      existingContent = parsed as ContentChunk[]
    }
  } catch {}

  if (pageSelector) {
    const before = existingContent.length
    existingContent = existingContent.filter((c) => {
      const parsed = parseScreenshotFilename(c.screenshot)
      // Keep chunks we can't parse (PDF entries, unusual shapes) — PAGES only
      // targets screenshot-style content.
      if (!parsed) return true
      return !pageSelector(parsed.page)
    })
    console.warn(
      `PAGES selector active: dropped ${before - existingContent.length} existing chunks for re-transcription`
    )
  }

  const processedScreenshots = new Set<string>(
    existingContent.map((c) => c.screenshot)
  )
  const screenshotsToProcess = pdfPath
    ? []
    : pageScreenshots.filter((s) => !processedScreenshots.has(s))

  if (!pdfPath && screenshotsToProcess.length === 0) {
    console.warn(
      '✅ Nothing to transcribe; content.json is already up to date.'
    )
    // Ensure file exists and is normalized
    await fs.writeFile(
      contentPath,
      JSON.stringify(
        [...existingContent].sort(
          (a, b) => a.index - b.index || a.page - b.page
        ),
        null,
        2
      )
    )
    console.log(JSON.stringify(existingContent, null, 2))
    // Even when there's nothing to transcribe, a prior extraction may have
    // failed to capture the book title — recover it from the title page.
    await backfillTitleFromTitlePage(outDir)
    return
  }

  const openai = new OpenAIClient()

  const transcribeConcurrency = parseIntEnv('TRANSCRIBE_CONCURRENCY', 16)
  const ocrConcurrency = parseIntEnv('TRANSCRIBE_OCR_CONCURRENCY', 1)

  const blankMarker = getEnv('TRANSCRIBE_BLANK_MARKER') || '[BLANK_PAGE]'
  const blankOpts = {
    whiteRatioThreshold: parseNumberEnv('TRANSCRIBE_BLANK_WHITE_RATIO', 0.95),
    whiteLuma: parseNumberEnv('TRANSCRIBE_BLANK_WHITE_LUMA', 245),
    blackLuma: parseNumberEnv('TRANSCRIBE_BLANK_BLACK_LUMA', 30),
    darkRatioMax: parseNumberEnv('TRANSCRIBE_BLANK_DARK_RATIO_MAX', 0.002),
    cropPct: parseNumberEnv('TRANSCRIBE_BLANK_CROP_PCT', 0.02),
    sampleStep: parseIntEnv('TRANSCRIBE_BLANK_SAMPLE_STEP', 4),
    maxDimension: 512
  } as const

  let content: ContentChunk[] = []

  if (pdfPath) {
    const numPages = await getPdfPageCount(pdfPath)
    assert(numPages > 0, `invalid PDF or empty PDF: ${pdfPath}`)

    const pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1)
    const keyForPage = (p: number) => `pdf:${pdfPath}#page=${p}`
    const pagesToProcess = pageNumbers.filter(
      (p) => !processedScreenshots.has(keyForPage(p))
    )

    if (pagesToProcess.length === 0) {
      console.warn(
        '✅ Nothing to transcribe; content.json is already up to date.'
      )
      await fs.writeFile(
        contentPath,
        JSON.stringify(
          [...existingContent].sort(
            (a, b) => a.index - b.index || a.page - b.page
          ),
          null,
          2
        )
      )
      console.log(JSON.stringify(existingContent, null, 2))
      return
    }

    const bar = createProgressBar(pagesToProcess.length)

    // Phase 1: extract embedded text for all pages
    const extracted = (await pMap(
      pagesToProcess,
      async (p) => {
        try {
          const text = await extractPdfPageText(pdfPath, p)
          return { page: p, text }
        } catch (err: any) {
          console.warn('error extracting PDF text; will OCR this page', {
            page: p,
            error: err?.message || err
          })
          return { page: p, text: '' }
        }
      },
      { concurrency: transcribeConcurrency }
    )) as Array<{ page: number; text: string }>

    const goodEnough = (t: string) => t.replaceAll(/\s/g, '').length >= 40

    const textPages: ContentChunk[] = extracted
      .filter((x) => goodEnough(x.text))
      .map((x) => {
        bar.tick(1)
        return {
          index: x.page - 1,
          page: x.page,
          text: x.text,
          screenshot: keyForPage(x.page)
        }
      })

    const ocrPages = extracted
      .filter((x) => !goodEnough(x.text))
      .map((x) => x.page)

    const ocrChunks: ContentChunk[] = (
      await pMap(
        ocrPages,
        async (p) => {
          const screenshot = keyForPage(p)
          try {
            const png = await renderPdfPageToPngBuffer(pdfPath, p)

            const blank = await isBlankPageFromPng(png, blankOpts)
            if (blank.isBlank) {
              const result: ContentChunk = {
                index: p - 1,
                page: p,
                text: blankMarker,
                screenshot
              }
              console.log({ ...result, blank: blank.analysis })
              bar.tick(1)
              return result
            }

            const imageBase64Url = `data:image/png;base64,${png.toString('base64')}`
            const text = await ocrImageToText(openai, {
              imageBase64Url,
              index: p - 1,
              page: p,
              screenshot
            })

            const result: ContentChunk = {
              index: p - 1,
              page: p,
              text,
              screenshot
            }

            console.log(result)
            bar.tick(1)
            return result
          } catch (err: any) {
            console.error(`error processing PDF page ${p} (${screenshot})`, err)
          }
        },
        { concurrency: Math.max(1, ocrConcurrency) }
      )
    ).filter(Boolean) as ContentChunk[]

    await closePdfRenderer(pdfPath)
    content = [...textPages, ...ocrChunks]
  } else {
    // Progress bar setup
    const totalScreens = screenshotsToProcess.length
    const bar = createProgressBar(totalScreens)

    content = (
      await pMap(
        screenshotsToProcess,
        async (screenshot) => {
          const screenshotBuffer = await fs.readFile(screenshot)
          // Filenames are "<index>-<page>.png" (zero-padded), e.g. "281-221.png".
          const parsed = parseScreenshotFilename(screenshot)
          assert(parsed, `invalid screenshot filename: ${screenshot}`)
          const { index, page } = parsed

          try {
            const blank = await isBlankPageFromPng(screenshotBuffer, blankOpts)
            if (blank.isBlank) {
              const result: ContentChunk = {
                index,
                page,
                text: blankMarker,
                screenshot
              }
              console.log({ ...result, blank: blank.analysis })
              bar.tick(1)
              return result
            }

            const imageBase64Url = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
            const text = await ocrImageToText(openai, {
              imageBase64Url,
              index,
              page,
              screenshot
            })

            const result: ContentChunk = {
              index,
              page,
              text,
              screenshot
            }
            console.log(result)

            // Update progress bar for this run
            bar.tick(1)

            return result
          } catch (err: any) {
            console.error(
              `error processing image ${index} (${screenshot})`,
              err
            )
          }
        },
        { concurrency: transcribeConcurrency }
      )
    ).filter(Boolean) as ContentChunk[]
  }

  // Merge with existing content, sort deterministically, and write
  const merged: ContentChunk[] = (
    [...existingContent, ...content] as ContentChunk[]
  ).sort((a, b) => a.index - b.index || a.page - b.page)

  await fs.writeFile(contentPath, JSON.stringify(merged, null, 2))
  console.log(JSON.stringify(merged, null, 2))

  progressBarNewline()

  // Backfill the book title from the title page if extraction couldn't capture
  // it from Amazon (Kindle mode only; PDF mode has no metadata.json).
  if (!pdfPath) {
    await backfillTitleFromTitlePage(outDir)
  }

  // Sanity-check the output. Warns on missing screenshots, index/page mismatches
  // vs. filename, and (if metadata.json is present) chapters with no text in
  // their page range. To repair a damaged content.json without re-OCR, run
  // `pnpm tsx src/verify-book-content.ts --repair` separately.
  const verifyResult = await verifyBookContent({
    outDir,
    pageScreenshots: pdfPath ? undefined : pageScreenshots,
    repair: false
  })
  if (verifyResult.issues.length > 0) {
    console.warn(
      `Verification found ${verifyResult.issues.length} issue(s); see warnings above.`
    )
  }
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
