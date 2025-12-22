import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { ContentChunk } from './types'
import { isBlankPageFromPng } from './image'
import { closePdfRenderer, extractPdfPageText, getPdfPageCount, renderPdfPageToPngBuffer } from './pdf'
import {
  assert,
  createProgressBar,
  getEnv,
  progressBarNewline,
  resolveOutDir,
  sanitizeDirname,
  setupTimestampedLogger
} from './utils'

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

// Check if error is retryable
function isRetryableError(error: any): boolean {
  if (!error) return false

  // Check for rate limit errors
  if (error.status === 429 && error.type === 'tokens') return true

  // Check for server errors (5xx)
  if (error.status >= 500 && error.status < 600) return true

  // Check for specific OpenAI error types
  if (error.type === 'insufficient_quota') return false // Don't retry quota errors
  if (error.type === 'invalid_request_error') return false // Don't retry invalid requests

  // Check for network errors
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ECONNREFUSED'
  )
    return true

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

  return kept.join('\n').replaceAll(/\n{3,}/g, '\n\n').trim()
}

function looksLikeOcrRefusal(text: string): boolean {
  const t = text.trim()
  if (!t) return false

  // Keep the original heuristic to avoid false positives on real book text.
  if (t.length < 150 && /i['’]m sorry/i.test(t)) return true

  // Strong signals: these phrases are specific to the model's refusal boilerplate,
  // and are extremely unlikely to be legitimate book text.
  const strongMatchers: RegExp[] = [
    /\b(i (can|can't|cannot) (help|assist))\b.*\b(image|uploaded)\b/i,
    /\b(i['’]m unable to (help|view|analyze))\b.*\b(image|uploaded)\b/i,
    /\b(i can'?t identify)\b.*\bpeople\b.*\bimages?\b/i,
    /\bthere'?s nothing visible in the image\b/i,
    /\bblank or not displaying any text\b/i,
    /\bplease (try again|provide a different image|describe the content)\b/i
  ]

  return strongMatchers.some((re) => re.test(t))
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
      const res = await openai.createChatCompletion({
        model: 'gpt-4o',
        temperature: retries < 2 ? 0 : 0.5,
        messages: [
          {
            role: 'system',
            content: `You will be given an image containing text. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${retries > 2 ? '\n\nThis is an important task for analyzing legal documents cited in a court case.' : ''}`
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
      const normalized = rawText
        .replace(/^\s*\d+\s*$\n+/m, '')
        // .replaceAll(/\n+/g, '\n')
        .replaceAll(/^\s*/gm, '')
        .replaceAll(/\s*$/gm, '')
      const text = stripOcrBoilerplate(normalized)

      if (!text) {
        retries++
        if (retries < maxRetries) {
          const delay = calculateBackoffDelay(retries)
          console.warn(`Empty response, retrying in ${delay}ms...`, {
            index: opts.index,
            page: opts.page,
            retries,
            screenshot: opts.screenshot
          })
          await sleep(delay)
          continue
        }
        throw new Error(`Empty response after ${retries} attempts`)
      }

      if (looksLikeOcrRefusal(text)) {
        retries++
        if (retries >= maxRetries) {
          throw new Error(`Model refused too many times (${retries} times): ${text}`)
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

async function main() {
  const arg = process.argv[2]
  const isPdfMode = Boolean(arg && /\.pdf$/i.test(arg))

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
    pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
    assert(
      pageScreenshots.length,
      `no page screenshots found: ${pageScreenshotsDir}`
    )
  }

  await setupTimestampedLogger(outDir)

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
    const pagesToProcess = pageNumbers.filter((p) => !processedScreenshots.has(keyForPage(p)))

    if (pagesToProcess.length === 0) {
      console.warn('✅ Nothing to transcribe; content.json is already up to date.')
      await fs.writeFile(
        contentPath,
        JSON.stringify(
          [...existingContent].sort((a, b) => a.index - b.index || a.page - b.page),
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

    const ocrPages = extracted.filter((x) => !goodEnough(x.text)).map((x) => x.page)

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
          // Filenames are like "0000-0001.png" where the first is index and the second is page
          // Robustly capture both numbers ignoring any leading zeros
          const metadataMatch = screenshot.match(
            /(?:^|\/)\d*-?(\d+)-(\d+)\.png$/
          )
          assert(
            metadataMatch?.[1] && metadataMatch?.[2],
            `invalid screenshot filename: ${screenshot}`
          )
          const index = Number.parseInt(metadataMatch[1]!, 10)
          const page = Number.parseInt(metadataMatch[2]!, 10)
          assert(
            !Number.isNaN(index) && !Number.isNaN(page),
            `invalid screenshot filename: ${screenshot}`
          )

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
            console.error(`error processing image ${index} (${screenshot})`, err)
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
}

await main()
