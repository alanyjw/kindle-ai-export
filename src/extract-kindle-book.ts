import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { input } from '@inquirer/prompts'
import delay from 'delay'
// Patchright is a drop-in Playwright fork that removes the automation tells
// Amazon's anti-bot checks for (the `Runtime.enable` CDP leak, `navigator
// .webdriver`, automation-only command-line flags).
import { chromium, type Locator } from 'patchright'
import sharp from 'sharp'

import { hasExportableBookMeta } from './book-meta'
import {
  blobRetentionInitScript,
  capturePageImage,
  fetchBlobAsBase64InPage
} from './page-image-capture'
import {
  type MetadataFetcher,
  recoverBookMetadata as recoverBookMetadataImpl
} from './recover-book-metadata'
import { type PageNav, parseTocItems, samePageNav } from './toc'
import type { BookInfo, BookMeta, BookMetadata, PageChunk } from './types'
import {
  assert,
  deromanize,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse,
  reportFatalError
} from './utils'

// ANSI color codes for terminal output
const colors = {
  reset: '\u001B[0m',
  bright: '\u001B[1m',
  dim: '\u001B[90m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  brightCyan: '\u001B[1;36m',
  brightYellow: '\u001B[1;33m',
  brightGreen: '\u001B[1;32m',
  brightRed: '\u001B[1;31m'
} as const

// Rendering the reader above 1x gives the OCR step sharper glyphs to read.
// Captured page images are scaled back down by this factor: the renderer sizes
// its PNG to the rendered image element's CSS box x DPR, so dividing by the DPR
// reproduces the CSS-pixel dimensions the old `screenshot({ scale: 'css' })`
// path wrote. Verified against a live book — the renderer emitted 1536x855 and
// pages landed at 1024x570, matching previously extracted books. `capturePage`
// logs both sizes on its first capture, so a reader-side change is visible.
const DEVICE_SCALE_FACTOR = 1.5

// Browser-aware TOC item: the shared `PageNav` position fields plus the
// Playwright `Locator` used to click the entry. `parseTocItems` is generic over
// this richer type, so the locator passes through its result untouched.
interface TocItem extends PageNav {
  title: string
  locator?: Locator
}

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

  // Check if extraction already exists and is complete (OFFLINE CHECK)
  const {
    resolveOutDir,
    fileExists,
    setupTimestampedLogger,
    createProgressBar,
    progressBarNewline
  } = await import('./utils')
  let outDir = await resolveOutDir(asin)
  if (useFileLogger) {
    await setupTimestampedLogger(outDir)
  }
  const metadataPath = path.join(outDir, 'metadata.json')
  const pagesDir = path.join(outDir, 'pages')

  if (!force && (await fileExists(metadataPath))) {
    try {
      const existingMetadata = JSON.parse(
        await fs.readFile(metadataPath, 'utf8')
      ) as BookMetadata
      const existingPages = existingMetadata.pages || []
      const expectedPages =
        (existingMetadata.meta as any)?.totalPages || existingPages.length

      // metadata.json can exist with `pages`/`toc` but no `meta` when a prior
      // run captured screenshots yet never intercepted Amazon's startReading /
      // YJmetadata network responses. The exporters need a title, so a
      // page-complete-but-title-missing book must NOT short-circuit as
      // "complete" — relaunching lets the response handler recapture it, and
      // existing screenshots are skipped so it's cheap. `info` is intentionally
      // not part of this test; see `hasExportableBookMeta`.
      const hasBookMeta = hasExportableBookMeta(existingMetadata)

      // Analyze screenshot files to understand extraction progress
      let actualScreenshots = 0
      let firstPage = 0
      let lastPage = 0
      let pageRange = ''

      try {
        const screenshotFiles = await fs.readdir(pagesDir)
        const pngFiles = screenshotFiles.filter((f) => f.endsWith('.png'))
        actualScreenshots = pngFiles.length

        if (pngFiles.length > 0) {
          // Parse filenames to extract page numbers (format: 0000-0001.png)
          const pageNumbers = pngFiles
            .map((f) => {
              const match = f.match(/^(\d+)-(\d+)\.png$/)
              return match ? Number.parseInt(match[2]!, 10) : 0
            })
            .filter((p) => p > 0)
            .sort((a, b) => a - b)

          if (pageNumbers.length > 0) {
            firstPage = pageNumbers[0]!
            lastPage = pageNumbers.at(-1)!
            pageRange = `${firstPage} to ${lastPage}`
          }
        }
      } catch (err) {
        console.warn(`⚠️  Could not analyze pages directory: ${pagesDir}`)
        if (err instanceof Error) {
          console.warn(`   Reason: ${err.message}`)
        }
        console.warn(
          `   This may indicate the extraction is incomplete or the directory structure has changed.`
        )
      }

      console.warn(
        `${colors.cyan}📚${colors.reset} Found existing extraction for ASIN: ${colors.yellow}${asin}${colors.reset}`
      )
      console.warn(
        `${colors.blue}📄${colors.reset} Metadata pages: ${colors.green}${existingPages.length}${colors.reset}`
      )
      console.warn(
        `${colors.magenta}🖼️${colors.reset} Actual screenshots: ${colors.green}${actualScreenshots}${colors.reset}`
      )
      if (pageRange) {
        console.warn(
          `${colors.yellow}📖${colors.reset} Page range: ${colors.bright}${pageRange}${colors.reset}`
        )
        // Calculate and explain front/back matter
        const firstContentPage = firstPage
        const lastContentPage = lastPage
        const totalPages = expectedPages

        console.warn(`\n${colors.brightCyan}📖 Book Structure:${colors.reset}`)
        if (firstContentPage > 1) {
          const frontMatterPages = firstContentPage - 1
          console.warn(
            `  ${colors.dim}📄${colors.reset} Front matter: ${colors.dim}pages 1-${frontMatterPages}${colors.reset}`
          )
        }
        console.warn(
          `  ${colors.green}📖${colors.reset} Main content: ${colors.brightGreen}pages ${firstContentPage}-${lastContentPage}${colors.reset} ${colors.dim}(${lastContentPage - firstContentPage + 1} pages)${colors.reset}`
        )
        if (lastContentPage < totalPages) {
          const backMatterStart = lastContentPage + 1
          console.warn(
            `  ${colors.dim}📄${colors.reset} Back matter: ${colors.dim}pages ${backMatterStart}-${totalPages}${colors.reset}`
          )
        }
        console.warn(
          `  ${colors.cyan}📚${colors.reset} Total: ${colors.brightCyan}${totalPages} pages${colors.reset}`
        )
      }

      // Use the higher count between metadata and actual screenshots
      const extractedPages = Math.max(existingPages.length, actualScreenshots)

      // Additional validation based on filename analysis
      if (pageRange && lastPage > 0) {
        // Check for potential gaps in page sequence
        const expectedScreenshots = lastPage - firstPage + 1
        if (actualScreenshots < expectedScreenshots) {
          console.warn(
            `⚠️  Potential gaps detected: ${actualScreenshots} screenshots for pages ${pageRange} (expected ${expectedScreenshots})`
          )
        }

        // Check if we've reached the expected end. Only treat the book as
        // complete when the captured metadata also carries a title; otherwise
        // fall through so we relaunch and recover it.
        if (lastPage >= expectedPages && hasBookMeta) {
          console.warn(
            '✅ Extraction appears complete based on page range. Use FORCE=true to re-extract.'
          )
          return { outDir }
        }
      }

      // A prior run that wrote metadata.json but never managed to save a single
      // screenshot leaves both `existingPages.length` and `actualScreenshots` at
      // 0. With `expectedPages` falling back to `existingPages.length`, the
      // generic check below would evaluate `0 >= 0` and declare the run
      // "complete" — making it impossible to resume without FORCE=true. Treat
      // a zero-progress state as definitely incomplete instead.
      if (extractedPages === 0) {
        console.warn(
          `${colors.yellow}⚠️  Prior extraction left no screenshots. Treating as incomplete and resuming from page ${colors.bright}1${colors.reset}${colors.yellow}...${colors.reset}`
        )
      } else if (extractedPages >= expectedPages) {
        if (hasBookMeta) {
          console.warn(
            `${colors.green}✅ Extraction appears complete. Use FORCE=true to re-extract.${colors.reset}`
          )
          return { outDir }
        }
        // Pages are all captured but `meta` never made it into metadata.json.
        // Relaunch (rather than returning) so the response handler can
        // recapture it; existing screenshots are skipped. Without this the
        // exporters fall back to an out-dir-derived title and FORCE=true would
        // be the only way to try again.
        console.warn(
          `${colors.yellow}⚠️  Pages look complete, but the book title is missing from metadata.json — relaunching to recover it (existing screenshots are skipped)...${colors.reset}`
        )
      } else {
        console.warn(
          `${colors.yellow}⚠️  Incomplete extraction detected. Will resume from page ${colors.bright}${extractedPages + 1}${colors.reset}${colors.yellow}...${colors.reset}`
        )
      }
    } catch {
      console.warn(
        '⚠️  Could not read existing metadata, continuing with fresh extraction...'
      )
    }
  }

  let userDataDir = path.join(outDir, 'data')
  let pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--hide-crash-restore-bubble',
      // Disable password manager popups
      '--disable-password-manager-reauthentication',
      '--disable-password-generation',
      '--disable-save-password-bubble',
      '--disable-password-manager',
      '--disable-password-manager-bubble',
      '--disable-passkeys',

      // Prefer basic password store and mock keychain to avoid macOS prompts/passkeys
      '--password-store=basic',
      '--use-mock-keychain',

      // Disable passkey/WebAuthn popups and password manager features
      '--disable-web-security',
      '--disable-features=PasswordManager,PasswordManagerOnboarding,WebAuthentication',
      '--disable-component-extensions-with-background-pages',
      '--disable-sync',
      '--no-first-run',

      // Performance optimizations
      '--enable-features=VaapiVideoDecoder,VaapiVideoEncoder',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'

      // NOTE: `--disable-blink-features=AutomationControlled`,
      // `--disable-default-apps` and `--disable-extensions` are deliberately
      // absent. Patchright manages that first flag itself, and treats the
      // other two as fingerprinting tells — a real Chrome profile has default
      // apps and extensions enabled, so forcing them off is itself a signal.
      // Re-adding any of them here would undo the stealth patches below.
    ],
    // Patchright already strips `--enable-automation`; `--no-sandbox` is a
    // strong automation tell and Chrome shows an admin warning without it.
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
    // Amazon's CSP would otherwise block the injected blob-capture hook.
    bypassCSP: true,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    viewport: { width: 1280, height: 720 }
  })

  // Block credential API at JavaScript level to prevent password prompts
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'credentials', {
      get: () => undefined
    })
  })

  // Keep the reader's rendered page images readable past its own
  // `revokeObjectURL`, so capture below can read the renderer's original PNG
  // instead of re-rasterizing it via a screenshot. Wrapped because this is the
  // part a reader or browser change could break: if it fails to install,
  // capture falls back to screenshots and extraction still completes.
  let blobRetentionInstalled = false
  try {
    await context.addInitScript(blobRetentionInitScript)
    blobRetentionInstalled = true
  } catch (err: any) {
    console.warn(
      `${colors.yellow}⚠️  blob retention unavailable, falling back to screenshots: ${err?.message ?? String(err)}${colors.reset}`
    )
  }

  const page = await context.newPage()

  // Counts how often each capture path ran, so a silent regression to
  // screenshot-only capture is visible in the log rather than invisible.
  const captureStats = { blob: 0, screenshot: 0 }

  /**
   * Capture the reader's currently rendered page image, preferring its
   * original PNG blob over a screenshot of the <img> element.
   */
  async function capturePage(src: string | null | undefined): Promise<Buffer> {
    const { buffer, source } = await capturePageImage({
      src: blobRetentionInstalled ? src : undefined,
      // Runs in Patchright's isolated world, which shares the page's origin
      // and so can read a main-world blob URL that is still alive.
      fetchBlob: (url) => page.evaluate(fetchBlobAsBase64InPage, url),
      screenshot: () =>
        page
          .locator(krRendererMainImageSelector)
          .screenshot({ type: 'png', scale: 'css' }),
      // The reader is assumed to render at the device scale factor; scale back
      // down so output dimensions match what `screenshot({ scale: 'css' })`
      // produced. The first capture logs both sizes so that assumption can be
      // checked against a real book.
      normalize: async (raw) => {
        const image = sharp(raw)
        const { width, height } = await image.metadata()
        if (!width || !height) return raw

        const scaled = {
          width: Math.round(width / DEVICE_SCALE_FACTOR),
          height: Math.round(height / DEVICE_SCALE_FACTOR)
        }

        if (captureStats.blob === 0) {
          console.warn(
            `${colors.cyan}🖼️${colors.reset}  Renderer PNG is ${width}x${height}; writing pages at ${scaled.width}x${scaled.height}`
          )
        }

        return image.resize(scaled).png().toBuffer()
      }
    })

    captureStats[source] += 1
    return buffer
  }

  let info: BookInfo | undefined
  let meta: BookMeta | undefined

  page.on('response', async (response) => {
    try {
      const status = response.status()
      if (status !== 200) return

      const url = new URL(response.url())
      if (
        url.hostname === 'read.amazon.com' &&
        url.pathname === '/service/mobile/reader/startReading' &&
        url.searchParams.get('asin')?.toLowerCase() === asin.toLowerCase()
      ) {
        const body: any = await response.json()
        delete body.karamelToken
        delete body.metadataUrl
        delete body.YJFormatVersion
        info = body
      } else if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return
        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }
        meta = metadata
      }
    } catch {}
  })

  // Actively recover book metadata when the reader serves itself from cache.
  //
  // The passive `page.on('response')` listener above only captures startReading
  // / YJmetadata when the reader actually issues them over the network. On a
  // warm persistent profile the Kindle reader frequently restores from its
  // service-worker cache and never re-requests them, leaving `info`/`meta`
  // unset — which then breaks every exporter ("invalid book metadata: missing
  // meta").
  //
  // The fetch runs INSIDE the page via page.evaluate, so it carries the reader's
  // exact cookies, Referer, and User-Agent. A bare `page.request` (a Node-side
  // client) gets a 403 from startReading because it doesn't look like the
  // in-page reader. For a cross-origin metadataUrl that the in-page fetch can't
  // read (CORS), we fall back to `page.request`, which isn't bound by CORS.
  const inPageFetcher: MetadataFetcher = {
    async fetchText(url) {
      const viaPage = await page
        .evaluate(async (u) => {
          try {
            // Runs in the browser; cast the init since the project's Node lib
            // types don't include the DOM RequestInit `cache` field.
            const r = await fetch(u, {
              credentials: 'include',
              cache: 'no-store'
            } as any)
            return { status: r.status, ok: r.ok, body: await r.text() }
          } catch {
            // Transport/CORS failure — signal a fallback to the caller.
            return null
          }
        }, url)
        .catch(() => null)
      if (viaPage) return viaPage

      // Fallback for cross-origin URLs the in-page fetch couldn't read.
      try {
        const r = await page.request.get(url)
        return { status: r.status(), ok: r.ok(), body: await r.text() }
      } catch {
        return null
      }
    }
  }

  async function recoverBookMetadata(): Promise<void> {
    if (info != null && meta != null) return

    const result = await recoverBookMetadataImpl(asin!, inPageFetcher, {
      info,
      meta
    })
    info = result.info
    meta = result.meta

    for (const warning of result.warnings) {
      console.warn(
        `${colors.yellow}⚠️  metadata recovery: ${warning}${colors.reset}`
      )
    }
    if (info != null && meta != null && result.warnings.length === 0) {
      console.warn(
        `${colors.green}✓ Recovered book metadata via direct fetch (the reader had served it from cache).${colors.reset}`
      )
    }
  }

  // Force the reader to re-issue its OWN metadata requests by defeating the
  // cache. On a warm persistent profile the Kindle reader restores from its
  // service-worker cache and never re-requests startReading / YJmetadata, so
  // the passive listener never sees them. Replaying the request ourselves gets
  // a 403 (it doesn't look like the in-page reader). The fix: clear the SW /
  // HTTP cache and reload so the reader makes the genuine request — which is
  // authenticated, carries the right headers, and IS captured passively.
  async function forceReaderMetadataRefresh(): Promise<void> {
    if (info != null && meta != null) return
    let cdp: Awaited<ReturnType<typeof context.newCDPSession>> | undefined
    try {
      cdp = await context.newCDPSession(page)
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      await page.evaluate(async () => {
        // Runs in the browser; the project's Node lib types don't include the
        // DOM serviceWorker / CacheStorage globals, so reach them dynamically.
        try {
          const nav = navigator as any
          if (nav.serviceWorker) {
            const regs = await nav.serviceWorker.getRegistrations()
            await Promise.all(regs.map((r: any) => r.unregister()))
          }
          const cacheStorage = (globalThis as any).caches
          if (cacheStorage) {
            const keys = await cacheStorage.keys()
            await Promise.all(keys.map((k: any) => cacheStorage.delete(k)))
          }
        } catch {}
      })
      await page.reload({ timeout: 60_000, waitUntil: 'domcontentloaded' })
      // Give the reader's bootstrap XHRs a beat to fire and be captured.
      await delay(3000)
    } catch (err: any) {
      console.warn(
        `${colors.yellow}⚠️  cache-bust metadata refresh failed: ${err?.message ?? String(err)}${colors.reset}`
      )
    } finally {
      // Re-enable the HTTP cache so the page-capture loop isn't slowed by
      // re-fetching reader assets on every navigation.
      try {
        await cdp?.send('Network.setCacheDisabled', { cacheDisabled: false })
      } catch {}
    }
  }

  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 60_000 }),
    page.waitForURL('**/ap/signin', { timeout: 60_000 })
  ])

  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    // await page.locator('input[type="checkbox"]').click()
    await page.locator('input[type="submit"]').click()

    if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
      // Note: You may need to manually dismiss password/passkey prompts
      console.log(
        'If you see password save or passkey prompts, please dismiss them manually'
      )

      const code = await input({
        message: '2-factor auth code?'
      })

      // Only enter 2-factor auth code if needed
      if (code) {
        await page.locator('input[type="tel"]').fill(code)
        await page
          .locator(
            'input[type="submit"][aria-labelledby="a-autoid-0-announce"]'
          )
          .click()
      }
    }

    if (!page.url().includes(bookReaderUrl)) {
      await page.goto(bookReaderUrl, { timeout: 90_000 })

      // page.waitForURL('**/kindle-library', { timeout: 30_000 })
      // await page.locator(`#title-${asin}`).click()
    }
  }

  // await page.goto('https://read.amazon.com/landing')
  // await page.locator('[id="top-sign-in-btn"]').click()
  // await page.waitForURL('**/signin')

  async function updateSettings() {
    await page.locator('ion-button[aria-label="Reader settings"]').click()
    await delay(1000)

    // Change font to Amazon Ember
    await page.locator('#AmazonEmber').click()

    // Change layout to single column
    await page
      .locator('[role="radiogroup"][aria-label$=" columns"]', {
        hasText: 'Single Column'
      })
      .click()

    await page.locator('ion-button[aria-label="Reader settings"]').click()
    await delay(1000)
  }

  async function goToPage(pageNumber: number) {
    await delay(1000)
    await page.locator('#reader-header').hover({ force: true })
    await delay(200)
    await page.locator('ion-button[aria-label="Reader menu"]').click()
    await delay(1000)
    // Page-mode books have a "Go to Page" menu item; location-mode books
    // (reflowable text without publisher pagination) have "Go to Location"
    // instead. Try both.
    const $goToPage = page.locator('ion-item[role="listitem"]', {
      hasText: 'Go to Page'
    })
    const $goToLocation = page.locator('ion-item[role="listitem"]', {
      hasText: 'Go to Location'
    })
    if (await $goToPage.isVisible().catch(() => false)) {
      await $goToPage.click()
    } else {
      await $goToLocation.click()
    }
    await page
      .locator('ion-modal input[placeholder="page number"]')
      .fill(`${pageNumber}`)
    // await page.locator('ion-modal button', { hasText: 'Go' }).click()
    await page
      .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
      .click()
    await delay(1000)
  }

  async function getPageNav() {
    const footerText = await page
      .locator('ion-footer ion-title')
      .first()
      .textContent()
    return parsePageNav(footerText)
  }

  async function ensureFixedHeaderUI() {
    await page.locator('.top-chrome').evaluate((el) => {
      el.style.transition = 'none'
      el.style.transform = 'none'
    })
  }

  async function dismissPossibleAlert(waitMs = 0) {
    // Kindle sometimes pops a "Most Recent Page Read — Go to location X?" alert
    // a beat after the reader loads, so callers can wait briefly for it to
    // appear instead of racing past it.
    const $alertNo = page.locator('ion-alert button', { hasText: 'No' })
    try {
      await $alertNo.waitFor({ state: 'visible', timeout: waitMs })
    } catch {
      // No alert appeared within the timeout — nothing to dismiss.
      return
    }
    if (await $alertNo.isVisible()) {
      await $alertNo.click()
      // Wait for the backdrop/alert to fully close before proceeding so
      // subsequent clicks aren't intercepted.
      await page
        .locator('ion-alert')
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() => {})
    }
  }

  // Initial dismiss with a short wait — handles both the "alert is already up"
  // and "alert appears within ~3s" cases.
  // First, try to make the reader re-issue its own (authenticated) metadata
  // requests by busting the cache + reloading; the passive listener captures
  // the genuine response. This runs before the alert/settings handling because
  // it reloads the page (which would reset them).
  await forceReaderMetadataRefresh()

  await dismissPossibleAlert(3000)
  await ensureFixedHeaderUI()
  // One more dismiss in case the alert appeared between calls (the reader UI
  // can be flaky about when it shows the sync prompt).
  await dismissPossibleAlert(500)
  await updateSettings()

  // Fallback: if the cache-bust reload still didn't surface metadata, replay
  // the request directly. Doing this before the TOC walk also lets the out-dir
  // get renamed with the title.
  await recoverBookMetadata()

  const initialPageNav = await getPageNav()

  await page.locator('ion-button[aria-label="Table of Contents"]').click()
  await delay(1000)

  const $tocItems = await page.locator('ion-list ion-item').all()
  const tocItems: Array<TocItem> = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)

  // Track the footer position across clicks so we can wait for the reader to
  // actually navigate after each TOC click instead of trusting a fixed delay.
  // A blind delay is unreliable on a cold reader: if Amazon's "Most Recent Page
  // Read" sync resumed the book at a position from another session (often the
  // *last* page if that's where it was last read), the footer can still show
  // that stale position when getPageNav() runs, recording a bogus page for the
  // TOC item — which then trips the end-of-book early-break below after a single
  // item and leaves the whole walk (and extraction) empty.
  let prevNav = initialPageNav
  for (let i = 0; i < $tocItems.length; i++) {
    const tocItem = $tocItems[i]!
    await tocItem.scrollIntoViewIfNeeded()

    const title = await tocItem.textContent()
    assert(title)

    await tocItem.click()

    // Wait for the footer to reflect the new position rather than a fixed delay.
    // Adjacent TOC entries can legitimately map to the same position (e.g. two
    // front-matter items), so fall back to whatever the footer shows once the
    // timeout elapses instead of failing.
    const settleTimeoutMs = 3000
    const settleStartMs = Date.now()
    let pageNav = await getPageNav()
    while (
      Date.now() - settleStartMs < settleTimeoutMs &&
      samePageNav(pageNav, prevNav)
    ) {
      await delay(100)
      pageNav = await getPageNav()
    }
    assert(pageNav)
    prevNav = pageNav

    tocItems.push({
      title,
      ...pageNav,
      locator: tocItem
    })

    console.warn({ title, ...pageNav })

    // Stop once a TOC item lands on the final page — no point walking the
    // remaining back matter. Skip this for the first item: a real book never
    // has its first TOC entry on the last page, so an `i === 0` hit is a stale
    // footer read, and breaking here would leave the walk with no content-start
    // entry for the main loop.
    if (i > 0 && pageNav.page !== undefined && pageNav.page >= pageNav.total) {
      break
    }
  }

  const parsedToc = parseTocItems(tocItems)
  // Rename out directory to include book title once known (if not already renamed)
  try {
    const title = (meta as any)?.title || (meta as any)?.titleText
    if (title) {
      const { sanitizeDirname } = await import('./utils')
      const newDirName = `${asin}-${sanitizeDirname(title)}`
      const newOutDir = path.join('out', newDirName)

      // Only rename if we're not already using the correct directory
      if (path.basename(outDir) !== newDirName) {
        console.warn(
          `📁 Renaming directory to include book title: ${newDirName}`
        )
        try {
          await fs.rename(outDir, newOutDir)
        } catch {
          // If rename fails, create the new directory and copy files
          await fs.mkdir(newOutDir, { recursive: true })
          await fs.mkdir(path.join(newOutDir, 'data'), { recursive: true })
          await fs.mkdir(path.join(newOutDir, 'pages'), { recursive: true })
        }
        outDir = newOutDir
        userDataDir = path.join(outDir, 'data')
        pageScreenshotsDir = path.join(outDir, 'pages')
        await fs.mkdir(userDataDir, { recursive: true })
        await fs.mkdir(pageScreenshotsDir, { recursive: true })
      } else {
        console.warn(
          `📁 Using existing directory with book title: ${path.basename(outDir)}`
        )
      }
    }
  } catch {}

  const toc: TocItem[] = tocItems.map(({ locator: _, ...tocItem }) => tocItem)

  // Best-effort: capture front-matter page images (Title Page, Cover,
  // Copyright) so the transcribe step can OCR the book title/author from them.
  // The main content loop below starts at the first page-numbered TOC entry and
  // skips front matter, so without this the title page is never screenshotted
  // and title-page metadata recovery has nothing to read. Entirely wrapped:
  // any failure logs a warning and falls back to the prior behavior.
  const frontMatter: Array<{ title: string; screenshot: string }> = []
  try {
    const wantedFrontMatter = [/title\s*page/i, /^cover$/i, /copyright/i]
    const capturedItems = new Set<TocItem>()
    const fmDir = path.join(outDir, 'front-matter')
    await fs.mkdir(fmDir, { recursive: true })

    for (const re of wantedFrontMatter) {
      const item = tocItems.find(
        (t) => t.locator && re.test(t.title) && !capturedItems.has(t)
      )
      if (!item) continue
      capturedItems.add(item)

      await item.locator!.scrollIntoViewIfNeeded()
      await item.locator!.click()
      await delay(750)
      // Close the TOC drawer so the reader image is visible for the screenshot.
      await page
        .locator('.side-menu-close-button')
        .click()
        .catch(() => {})
      await delay(500)

      const b = await capturePage(
        await page.locator(krRendererMainImageSelector).getAttribute('src')
      )
      const slug =
        item.title
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, '-')
          .replaceAll(/^-+|-+$/g, '') || 'front-matter'
      const fmPath = path.join(
        fmDir,
        `${`${frontMatter.length}`.padStart(2, '0')}-${slug}.png`
      )
      await fs.writeFile(fmPath, b)
      frontMatter.push({ title: item.title.trim(), screenshot: fmPath })

      // Reopen the TOC for the next item / the content-start click below.
      await page
        .locator('ion-button[aria-label="Table of Contents"]')
        .click()
        .catch(() => {})
      await delay(750)
    }

    if (frontMatter.length > 0) {
      console.warn(
        `${colors.cyan}📄${colors.reset} Captured ${frontMatter.length} front-matter page(s) for metadata recovery`
      )
    }
  } catch (err: any) {
    console.warn(
      `${colors.yellow}⚠️  front-matter capture skipped: ${err?.message ?? String(err)}${colors.reset}`
    )
  }

  // Ensure the TOC drawer is open for the content-start click below — the
  // front-matter capture above toggles it and may have left it closed.
  if (
    !(await page
      .locator('.side-menu-close-button')
      .isVisible()
      .catch(() => false))
  ) {
    await page
      .locator('ion-button[aria-label="Table of Contents"]')
      .click()
      .catch(() => {})
    await delay(750)
  }

  const total = parsedToc.firstPageTocItem.total
  const pagePadding = `${total * 2}`.length
  await parsedToc.firstPageTocItem.locator!.scrollIntoViewIfNeeded()
  await parsedToc.firstPageTocItem.locator!.click()

  const totalContentPages = Math.min(
    parsedToc.afterLastContentPosition ?? total,
    total
  )
  assert(totalContentPages > 0, 'No content pages found')

  await page.locator('.side-menu-close-button').click()
  await delay(1000)

  // Load existing pages if resuming (we already checked metadata exists above)
  let pages: Array<PageChunk> = []
  let startPage = 1

  if (!force && (await fileExists(metadataPath))) {
    try {
      const existingMetadata = JSON.parse(
        await fs.readFile(metadataPath, 'utf8')
      ) as BookMetadata
      pages = existingMetadata.pages || []

      // Analyze actual screenshots to determine resume point
      let actualScreenshots = 0
      let lastExtractedPage = 0

      try {
        const screenshotFiles = await fs.readdir(pageScreenshotsDir)
        const pngFiles = screenshotFiles.filter((f) => f.endsWith('.png'))
        actualScreenshots = pngFiles.length

        if (pngFiles.length > 0) {
          // Parse filenames to find the highest page number extracted
          const pageNumbers = pngFiles
            .map((f) => {
              const match = f.match(/^(\d+)-(\d+)\.png$/)
              return match ? Number.parseInt(match[2]!, 10) : 0
            })
            .filter((p) => p > 0)

          if (pageNumbers.length > 0) {
            lastExtractedPage = Math.max(...pageNumbers)
          }
        }
      } catch (err) {
        console.warn(
          `⚠️  Could not analyze existing screenshots in: ${pageScreenshotsDir}`
        )
        if (err instanceof Error) {
          console.warn(`   Reason: ${err.message}`)
        }
        console.warn(
          `   This may indicate the pages directory is missing or corrupted. Will proceed with fresh extraction.`
        )
      }

      const extractedPages = Math.max(pages.length, actualScreenshots)
      if (extractedPages > 0) {
        // If we have screenshots but no metadata pages, we need to rebuild the pages array
        if (actualScreenshots > pages.length) {
          console.warn(
            `🔄 Found ${actualScreenshots} screenshots but only ${pages.length} metadata entries. Will rebuild metadata...`
          )
          pages = [] // Clear pages array to rebuild from screenshots
        }

        // Use the actual last page extracted from filenames
        startPage =
          lastExtractedPage > 0 ? lastExtractedPage + 1 : extractedPages + 1
        console.warn(
          `🔄 Resuming extraction from page ${startPage} (last extracted: ${lastExtractedPage})...`
        )
      }
    } catch {
      console.warn('⚠️  Could not load existing pages, starting fresh...')
    }
  }

  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  // Navigate to startPage when resuming. For fresh runs (startPage === 1) we
  // rely on `firstPageTocItem.locator!.click()` above to have landed the
  // reader at the start of the main content. Calling goToPage on a fresh run
  // is also unsafe for location-mode books, where the "Go to Page/Location"
  // modal placeholder differs from the page-mode case.
  if (startPage > 1) {
    console.warn(`📖 Navigating to page ${startPage}...`)
    await goToPage(startPage)
  }

  // Progress bar setup
  const currentNavAtStart = await getPageNav()
  const startAtPage =
    currentNavAtStart?.page ?? currentNavAtStart?.location ?? startPage
  const totalToRead = Math.max(0, totalContentPages - startAtPage)
  const bar = createProgressBar(totalToRead)

  // Stall detection. See guard inside the loop for the why.
  let lastSrc: string | null | undefined
  let stuckCount = 0
  const maxStuckIterations = 2

  do {
    const pageNav = await getPageNav()
    // For location-mode books `pageNav.page` is undefined and the position is
    // exposed as `pageNav.location`. Treat them uniformly downstream — the
    // PageChunk's `page` field stores whichever position the reader uses for
    // this book.
    const position = pageNav?.page ?? pageNav?.location
    if (position === undefined) {
      break
    }
    if (position >= totalContentPages) {
      break
    }

    const src = await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src')

    // The reader can land on a "last extractable" page where the chevron
    // click no longer changes the rendered image. The inner navigation loop
    // exits via its catch, but the outer loop would otherwise re-iterate
    // forever, re-screenshotting the same content (observed: 500+ duplicates
    // of one page). Detect this by tracking the image src across outer
    // iterations: if it stops changing, we're truly stuck.
    //
    // We deliberately key on src rather than the footer page label, because
    // a single print page can span multiple screens (each with a unique src)
    // and we don't want to bail prematurely on those — that would truncate
    // content. Empirically pages typically have 1–3 screens but can have
    // more; src repetition is the only reliable "no progress" signal.
    if (lastSrc !== undefined && src === lastSrc) {
      stuckCount += 1
      if (stuckCount >= maxStuckIterations) {
        console.warn(
          `${colors.yellow}⚠️  Reader stalled — image src unchanged across ${stuckCount + 1} iterations at position ${position}. Stopping extraction.${colors.reset}`
        )
        break
      }
    } else {
      stuckCount = 0
    }
    lastSrc = src

    const index = pages.length
    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') +
        '-' +
        `${position}`.padStart(pagePadding, '0') +
        '.png'
    )

    // Skip if screenshot already exists (unless force mode)
    if (!force && (await fileExists(screenshotPath))) {
      console.warn(`⏭️  Skipping page ${position} (already exists)`)

      // Still add to pages array for consistency
      pages.push({
        index,
        page: position,
        total: pageNav!.total,
        screenshot: screenshotPath
      })

      // Update progress bar for this run
      bar.tick(1)

      // Navigate to next page
      let retries = 0
      do {
        try {
          if (retries % 10 === 0) {
            await page
              .locator('.kr-chevron-container-right')
              .click({ timeout: 1000 })
          }
          const newSrc = await page
            .locator(krRendererMainImageSelector)
            .getAttribute('src')
          const currentSrc = await page
            .locator(krRendererMainImageSelector)
            .getAttribute('src')
          if (newSrc !== currentSrc) break
          await delay(100)
          ++retries
        } catch (err: any) {
          console.warn(
            'unable to navigate to next page; breaking...',
            err.message
          )
          break
        }
      } while (retries < 10)

      continue
    }

    const b = await capturePage(src)

    await fs.writeFile(screenshotPath, b)
    pages.push({
      index,
      page: position,
      total: pageNav!.total,
      screenshot: screenshotPath
    })

    console.warn(pages.at(-1))

    // Update progress bar for this run
    bar.tick(1)

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    if (position >= totalContentPages) {
      break
    }

    // Advance to the next page. Click once, then poll the rendered image
    // src for a change with a generous timeout. Only re-click on an actual
    // timeout (rare lost click), capped at 3 attempts. The previous
    // implementation re-clicked on a fixed 1s cadence and queued multiple
    // chevron events on slow renders — the reader processed every queued
    // click, advancing past pages we hadn't captured yet (~25% skip rate
    // observed). Single-click + bounded poll eliminates the queueing.
    const advanceTimeoutMs = 5000
    const maxAdvanceAttempts = 3
    let advanced = false
    for (
      let attempt = 0;
      attempt < maxAdvanceAttempts && !advanced;
      attempt++
    ) {
      try {
        await page
          .locator('.kr-chevron-container-right')
          .click({ timeout: 1000 })
      } catch (err: any) {
        console.warn(
          'unable to navigate to next page; breaking...',
          err.message
        )
        break
      }

      const startMs = Date.now()
      while (Date.now() - startMs < advanceTimeoutMs) {
        const newSrc = await page
          .locator(krRendererMainImageSelector)
          .getAttribute('src')
        if (newSrc !== src) {
          advanced = true
          break
        }
        await delay(100)
      }

      if (!advanced && attempt < maxAdvanceAttempts - 1) {
        console.warn(
          `next-page click did not advance src within ${advanceTimeoutMs}ms (attempt ${attempt + 1}/${maxAdvanceAttempts}); retrying...`
        )
      }
    }
  } while (true)

  progressBarNewline()

  // Fail early: if a fresh run captured zero pages, the reader never produced
  // a single screenshot (login failed, the book never opened, or the
  // TOC/navigation selectors changed). Writing an empty metadata.json and
  // exiting 0 here would let a `&&` chain proceed to transcription against
  // nothing. Throw instead so the top-level handler stops the pipeline.
  // (Resumed runs always carry their already-extracted pages, so this only
  // trips on a genuinely empty extraction.)
  if (pages.length === 0) {
    await page.close().catch(() => {})
    await context.close().catch(() => {})
    throw new Error(
      'No pages were extracted — the reader produced no captureable pages. ' +
        'This usually means Amazon login failed, the book did not open, or the ' +
        'reader navigation/TOC selectors changed. Nothing was saved; re-run to retry.'
    )
  }

  // `info`/`meta` are genuinely optional (see BookMetadata) — spread them in
  // only when captured rather than asserting non-null, so the absent case is
  // expressed rather than papered over.
  const result: BookMetadata = {
    ...(info != null ? { info } : {}),
    ...(meta != null ? { meta } : {}),
    toc,
    pages,
    ...(frontMatter.length > 0 ? { frontMatter } : {})
  }

  // `meta` (book title, author, page totals) and `info` (Kindle sync
  // positions) come from Amazon's startReading / YJmetadata responses snooped
  // during this run. Neither is fatal, and they fail for different reasons, so
  // report them differently:
  //
  // - A missing title still has two recovery layers downstream (title-page OCR
  //   during transcription, then an out-dir-derived fallback in the exporters),
  //   so warn but don't imply the pipeline is broken.
  // - A missing `info` has no downstream consumer at all, and Amazon has 403'd
  //   `startReading` since ~June 2026. Saying so once is useful; presenting it
  //   as something to re-run for is not.
  if (meta == null) {
    console.warn(
      `${colors.yellow}⚠️  Book metadata was not captured (Amazon's metadata responses never fired). ` +
        `Pages were saved; the transcribe step will try to recover the title from the title page.${colors.reset}`
    )
  }

  if (info == null) {
    console.warn(
      `${colors.yellow}⚠️  Kindle sync positions (info) were not captured. ` +
        `Exports are unaffected — only read-position interop is lost.${colors.reset}`
    )
  }

  // Verification: Check if all expected pages were extracted
  const extractedPages = pages.length
  const expectedPages = totalContentPages
  const missingPages = expectedPages - extractedPages

  console.warn('\n=== EXTRACTION VERIFICATION ===')
  console.warn(`Expected pages: ${expectedPages}`)
  console.warn(`Extracted pages: ${extractedPages}`)
  console.warn(`Missing pages: ${missingPages}`)

  const capturedTotal = captureStats.blob + captureStats.screenshot
  if (capturedTotal > 0) {
    console.warn(
      `Image capture: ${captureStats.blob} from renderer blobs, ${captureStats.screenshot} from screenshots`
    )
    // Screenshots are the lossy path; if they dominate, blob capture has
    // regressed and transcription quality will quietly suffer.
    if (captureStats.screenshot > captureStats.blob) {
      console.warn(
        `${colors.yellow}⚠️  Most pages fell back to screenshots — the reader's blob capture hook may no longer be effective.${colors.reset}`
      )
    }
  }

  if (missingPages > 0) {
    console.warn(
      `${colors.red}⚠️  WARNING: ${colors.brightRed}${missingPages} pages were not extracted!${colors.reset}`
    )
    console.warn(
      `${colors.yellow}This might indicate navigation issues or the book ended early.${colors.reset}`
    )
    console.warn(
      `${colors.yellow}Run the script again to continue extraction from where it left off.${colors.reset}`
    )
  } else if (extractedPages === expectedPages) {
    console.warn(
      `${colors.green}✅ SUCCESS: All expected pages were extracted!${colors.reset}`
    )
  } else {
    console.warn(
      `${colors.cyan}ℹ️  INFO: Extracted ${colors.bright}${extractedPages}${colors.reset}${colors.cyan} pages (expected ${colors.bright}${expectedPages}${colors.reset}${colors.cyan})${colors.reset}`
    )
  }

  // Show page range extracted
  if (pages.length > 0) {
    const firstPage = Math.min(...pages.map((p) => p.page))
    const lastPage = Math.max(...pages.map((p) => p.page))
    console.warn(
      `\n${colors.brightYellow}📖 Extraction Summary:${colors.reset}`
    )
    console.warn(
      `  ${colors.yellow}📖${colors.reset} Page range: ${colors.bright}${firstPage} to ${lastPage}${colors.reset}`
    )

    // Explain the page structure
    const totalPages = pages[0]?.total || 0
    console.warn(`\n${colors.brightCyan}📖 Book Structure:${colors.reset}`)
    if (firstPage > 1) {
      const frontMatterPages = firstPage - 1
      console.warn(
        `  ${colors.dim}📄${colors.reset} Front matter: ${colors.dim}pages 1-${frontMatterPages}${colors.reset}`
      )
    }
    console.warn(
      `  ${colors.green}📖${colors.reset} Main content: ${colors.brightGreen}pages ${firstPage}-${lastPage}${colors.reset} ${colors.dim}(${lastPage - firstPage + 1} pages)${colors.reset}`
    )
    if (lastPage < totalPages) {
      const backMatterStart = lastPage + 1
      console.warn(
        `  ${colors.dim}📄${colors.reset} Back matter: ${colors.dim}pages ${backMatterStart}-${totalPages}${colors.reset}`
      )
    }
    console.warn(
      `  ${colors.cyan}📚${colors.reset} Total: ${colors.brightCyan}${totalPages} pages${colors.reset}`
    )
  }

  if (startPage > 1) {
    console.warn(
      `🔄 This was a resumed extraction starting from page ${startPage}`
    )
  }

  console.warn('===============================\n')

  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(result, null, 2)
  )
  console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  await page.close()
  await context.close()

  return { outDir }
}

function parsePageNav(text: string | null): PageNav | undefined {
  {
    // Parse normal page locations
    const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const page = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(page) || Number.isNaN(total)) {
        return undefined
      }

      return { page, total }
    }
  }

  {
    // Parse locations which are not part of the main book pages
    // (toc, copyright, title, etc)
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const location = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }

  {
    // Parse locations which use roman numerals
    const match = text?.match(/page\s+([cdilmvx]+)\s+of\s+(\d+)/i)
    if (match) {
      const location = deromanize(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }
}

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
