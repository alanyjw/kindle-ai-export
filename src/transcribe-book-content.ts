import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { ContentChunk } from './types'
import { assert, getEnv, resolveOutDir } from './utils'

// Utility function for exponential backoff with jitter
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Calculate delay with exponential backoff and jitter
function calculateBackoffDelay(attempt: number, baseDelay = 1000, maxDelay = 30_000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1)
  const jitter = Math.random() * 0.1 * exponentialDelay // Add up to 10% jitter
  return Math.min(exponentialDelay + jitter, maxDelay)
}

// Check if error is retryable
function isRetryableError(error: any): boolean {
  if (!error) return false

  // Check for rate limit errors
  if (error.status === 429) return true

  // Check for server errors (5xx)
  if (error.status >= 500 && error.status < 600) return true

  // Check for specific OpenAI error types
  if (error.type === 'insufficient_quota') return false // Don't retry quota errors
  if (error.type === 'invalid_request_error') return false // Don't retry invalid requests

  // Check for network errors
  if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') return true

  return false
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = await resolveOutDir(asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  assert(pageScreenshots.length, `no page screenshots found: ${pageScreenshotsDir}`)

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
  const screenshotsToProcess = pageScreenshots.filter(
    (s) => !processedScreenshots.has(s)
  )

  if (screenshotsToProcess.length === 0) {
    console.warn('✅ Nothing to transcribe; content.json is already up to date.')
    // Ensure file exists and is normalized
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

  const openai = new OpenAIClient()

  const content: ContentChunk[] = (
    await pMap(
      screenshotsToProcess,
      async (screenshot) => {
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
        // Filenames are like "0000-0001.png" where the first is index and the second is page
        // Robustly capture both numbers ignoring any leading zeros
        const metadataMatch = screenshot.match(/(?:^|\/)\d*-?(\d+)-(\d+)\.png$/)
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
                          url: screenshotBase64
                        }
                      }
                    ] as any
                  }
                ]
              })

              const rawText = res.choices[0]?.message.content!
              const text = rawText
                .replace(/^\s*\d+\s*$\n+/m, '')
                // .replaceAll(/\n+/g, '\n')
                .replaceAll(/^\s*/gm, '')
                .replaceAll(/\s*$/gm, '')

              if (!text) {
                retries++
                if (retries < maxRetries) {
                  const delay = calculateBackoffDelay(retries)
                  console.warn(`Empty response, retrying in ${delay}ms...`, { index, retries, screenshot })
                  await sleep(delay)
                  continue
                }
                throw new Error(`Empty response after ${retries} attempts`)
              }

              if (text.length < 100 && /i'm sorry/i.test(text)) {
                retries++
                if (retries >= maxRetries) {
                  throw new Error(
                    `Model refused too many times (${retries} times): ${text}`
                  )
                }

                // Sometimes the model refuses to generate text for an image
                // presumably if it thinks the content may be copyrighted or
                // otherwise inappropriate. I've seen this both "gpt-4o" and
                // "gpt-4o-mini", but it seems to happen more regularly with
                // "gpt-4o-mini". If we suspect a refusal, we'll retry with a
                // higher temperature and cross our fingers.
                const delay = calculateBackoffDelay(retries)
                console.warn('retrying refusal...', { index, text, screenshot, retries, delay })
                await sleep(delay)
                continue
              }

              const result: ContentChunk = {
                index,
                page,
                text,
                screenshot
              }
              console.log(result)

              return result
            } catch (err: any) {
              retries++

              // Check if this is a retryable error
              if (!isRetryableError(err) || retries >= maxRetries) {
                throw err
              }

              const delay = calculateBackoffDelay(retries)
              console.warn(`API error, retrying in ${delay}ms...`, {
                index,
                retries,
                error: err.message || err,
                status: err.status,
                type: err.type,
                screenshot
              })

              await sleep(delay)
            }
          }

          throw new Error(`Max retries (${maxRetries}) exceeded`)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency: 16 }
    )
  ).filter(Boolean)

  // Merge with existing content, sort deterministically, and write
  const merged: ContentChunk[] = (
    [...existingContent, ...content] as ContentChunk[]
  ).sort((a, b) => a.index - b.index || a.page - b.page)

  await fs.writeFile(contentPath, JSON.stringify(merged, null, 2))
  console.log(JSON.stringify(merged, null, 2))
}

await main()
