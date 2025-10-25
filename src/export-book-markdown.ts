import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { assert, createProgressBar, getEnv, progressBarNewline, resolveOutDir, sanitizeDirname, setupTimestampedLogger } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = await resolveOutDir(asin)
  await setupTimestampedLogger(outDir)

  const content = JSON.parse(
    await fs.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  const metadata = JSON.parse(
    await fs.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  // Count actual items that will be processed (have page numbers and can find content)
  let actualProcessableCount = 0
  for (let i = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const startIndex = content.findIndex((c) => c.page >= tocItem.page!)
    if (startIndex !== -1) actualProcessableCount++
  }

  const bar = createProgressBar(actualProcessableCount)

  let output = `# ${title}

By ${authors.join(', ')}

---

## Table of Contents

${metadata.toc
  .filter((tocItem) => tocItem.page !== undefined)
  .map(
    (tocItem) =>
      `- [${tocItem.title}](#${tocItem.title.toLowerCase().replaceAll(/[^\da-z]+/g, '-')})`
  )
  .join('\n')}

---`

  for (let i = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const startIndex = content.findIndex((c) => c.page >= tocItem.page!)
    const endIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length

    if (startIndex === -1) continue

    const chunks = content.slice(startIndex, endIndex)

    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replaceAll('\n', '\n\n')

    output += `

## ${tocItem.title}

${text}`

    bar.tick(1)
  }

  progressBarNewline()

  const safeTitle = sanitizeDirname(title || asin)
  const markdownPath = path.join(outDir, `${safeTitle}.md`)

  await fs.writeFile(markdownPath, output)
  console.log(`Export complete. Wrote markdown to: ${markdownPath}`)
  console.log(`TOC sections processed: ${actualProcessableCount}`)
}

await main()
