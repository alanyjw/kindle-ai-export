import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator } from 'playwright'

import type { BookInfo, BookMeta, BookMetadata, PageChunk } from './types'
import {
  assert,
  deromanize,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse
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

interface PageNav {
  page?: number
  location?: number
  total: number
}

interface TocItem extends PageNav {
  title: string
  locator?: Locator
}

async function main() {
  const asin = getEnv('ASIN')
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
  await setupTimestampedLogger(outDir)
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

        // Check if we've reached the expected end
        if (lastPage >= expectedPages) {
          console.warn(
            '✅ Extraction appears complete based on page range. Use FORCE=true to re-extract.'
          )
          return
        }
      }

      if (extractedPages >= expectedPages) {
        console.warn(
          `${colors.green}✅ Extraction appears complete. Use FORCE=true to re-extract.${colors.reset}`
        )
        return
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

      // Disable passkey/WebAuthn popups
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-features=WebAuthentication',
      '--disable-component-extensions-with-background-pages',
      '--no-first-run'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 720 }
  })
  const page = await context.newPage()

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

  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    // await page.locator('input[type="checkbox"]').click()
    await page.locator('input[type="submit"]').click()

    if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
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
      await page.goto(bookReaderUrl)

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
    await page
      .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
      .click()
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

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('ion-alert button', { hasText: 'No' })
    if (await $alertNo.isVisible()) {
      $alertNo.click()
    }
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  const initialPageNav = await getPageNav()

  await page.locator('ion-button[aria-label="Table of Contents"]').click()
  await delay(1000)

  const $tocItems = await page.locator('ion-list ion-item').all()
  const tocItems: Array<TocItem> = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)
  for (const tocItem of $tocItems) {
    await tocItem.scrollIntoViewIfNeeded()

    const title = await tocItem.textContent()
    assert(title)

    await tocItem.click()
    await delay(250)

    const pageNav = await getPageNav()
    assert(pageNav)

    tocItems.push({
      title,
      ...pageNav,
      locator: tocItem
    })

    console.warn({ title, ...pageNav })

    // if (pageNav.page !== undefined) {
    //   break
    // }

    if (pageNav.page !== undefined && pageNav.page >= pageNav.total) {
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

  const total = parsedToc.firstPageTocItem.total
  const pagePadding = `${total * 2}`.length
  await parsedToc.firstPageTocItem.locator!.scrollIntoViewIfNeeded()
  await parsedToc.firstPageTocItem.locator!.click()

  const totalContentPages = Math.min(
    parsedToc.afterLastPageTocItem?.page
      ? parsedToc.afterLastPageTocItem!.page
      : total,
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

  // Navigate to start page if resuming
  if (startPage > 1) {
    console.warn(`📖 Navigating to page ${startPage}...`)
    await goToPage(startPage)
  }

  // Progress bar setup
  const currentNavAtStart = await getPageNav()
  const startAtPage = currentNavAtStart?.page ?? startPage
  const totalToRead = Math.max(0, totalContentPages - startAtPage)
  const bar = createProgressBar(totalToRead)

  do {
    const pageNav = await getPageNav()
    if (pageNav?.page === undefined) {
      break
    }
    if (pageNav.page >= totalContentPages) {
      break
    }

    const index = pages.length
    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') +
        '-' +
        `${pageNav.page}`.padStart(pagePadding, '0') +
        '.png'
    )

    // Skip if screenshot already exists (unless force mode)
    if (!force && (await fileExists(screenshotPath))) {
      console.warn(`⏭️  Skipping page ${pageNav.page} (already exists)`)

      // Still add to pages array for consistency
      pages.push({
        index,
        page: pageNav.page,
        total: pageNav.total,
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

    const src = await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src')

    const b = await page
      .locator(krRendererMainImageSelector)
      .screenshot({ type: 'png', scale: 'css' })

    await fs.writeFile(screenshotPath, b)
    pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })

    console.warn(pages.at(-1))

    // Update progress bar for this run
    bar.tick(1)

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    if (pageNav.page >= totalContentPages) {
      break
    }

    let retries = 0

    // Occasionally the next page button doesn't work, so ensure that the main
    // image src actually changes before continuing.
    do {
      try {
        // Navigate to the next page
        // await delay(100)
        if (retries % 10 === 0) {
          if (retries > 0) {
            console.warn('retrying...', {
              src,
              retries,
              ...pages.at(-1)
            })
          }

          // Click the next page button
          await page
            .locator('.kr-chevron-container-right')
            .click({ timeout: 1000 })
        }
        // await delay(500)
      } catch (err: any) {
        // No next page to navigate to
        console.warn(
          'unable to navigate to next page; breaking...',
          err.message
        )
        break
      }

      const newSrc = await page
        .locator(krRendererMainImageSelector)
        .getAttribute('src')
      if (newSrc !== src) {
        break
      }

      if (pageNav.page >= totalContentPages) {
        break
      }

      await delay(100)

      ++retries
    } while (true)
  } while (true)

  progressBarNewline()

  const result: BookMetadata = { info: info!, meta: meta!, toc, pages }

  // Verification: Check if all expected pages were extracted
  const extractedPages = pages.length
  const expectedPages = totalContentPages
  const missingPages = expectedPages - extractedPages

  console.warn('\n=== EXTRACTION VERIFICATION ===')
  console.warn(`Expected pages: ${expectedPages}`)
  console.warn(`Extracted pages: ${extractedPages}`)
  console.warn(`Missing pages: ${missingPages}`)

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

function parseTocItems(tocItems: TocItem[]) {
  // Find the first page in the TOC which contains the main book content
  // (after the title, table of contents, copyright, etc)
  const firstPageTocItem = tocItems.find((item) => item.page !== undefined)
  assert(firstPageTocItem, 'Unable to find first valid page in TOC')

  // Try to find the first page in the TOC after the main book content
  // (e.g. acknowledgements, about the author, etc)
  const afterLastPageTocItem = tocItems.find((item) => {
    if (item.page === undefined) return false
    if (item === firstPageTocItem) return false

    const percentage = item.page / item.total
    if (percentage < 0.9) return false

    if (/acknowledgements/i.test(item.title)) return true
    if (/^discover more$/i.test(item.title)) return true
    if (/^extras$/i.test(item.title)) return true
    if (/about the author/i.test(item.title)) return true
    if (/meet the author/i.test(item.title)) return true
    if (/^also by /i.test(item.title)) return true
    if (/^copyright$/i.test(item.title)) return true
    if (/ teaser$/i.test(item.title)) return true
    if (/ preview$/i.test(item.title)) return true
    if (/^excerpt from/i.test(item.title)) return true
    if (/^cast of characters$/i.test(item.title)) return true
    if (/^timeline$/i.test(item.title)) return true
    if (/^other titles/i.test(item.title)) return true

    return false
  })

  return {
    firstPageTocItem,
    afterLastPageTocItem
  }
}

await main()
