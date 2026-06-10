import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BookMetadata } from './types'
import { getEnv, reportFatalError, resolveOutDir } from './utils'

// Backfill book metadata (title + authors) into a book's metadata.json when
// automated capture failed — e.g. Amazon 403s the reader metadata API, leaving
// metadata.json with pages/toc but no `meta`. The exporters only need
// meta.title and meta.authorList, so this is enough to unblock every export.
//
// Usage:
//   pnpm tsx src/set-book-meta.ts <asin|outDir> "<title>" "<author[,author2]>"
//   pnpm tsx src/set-book-meta.ts "On Writing Well" "William Zinsser"   # uses ASIN env
export async function setBookMeta(
  outDir: string,
  title: string,
  authorList: string[]
): Promise<string> {
  const metadataPath = path.join(outDir, 'metadata.json')
  const raw = await fs.readFile(metadataPath, 'utf8')
  const metadata = JSON.parse(raw) as Partial<BookMetadata> & {
    meta?: Record<string, unknown>
  }

  // Preserve any partial meta that was captured; only set the fields exporters
  // require. Immutable update — never mutate the parsed object in place.
  const meta = { ...(metadata.meta ?? {}), title, authorList }
  const updated = { ...metadata, meta }

  await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2))
  return metadataPath
}

// Distinguishes an explicit out-dir argument from an ASIN.
function looksLikePath(arg: string): boolean {
  return arg.includes('/') || arg.includes(path.sep) || arg.startsWith('out')
}

async function main() {
  const args = process.argv.slice(2)

  // Two forms: [asinOrDir, title, authors] or [title, authors] (+ ASIN env).
  let target: string | undefined
  let title: string | undefined
  let authorsArg: string | undefined
  if (args.length >= 3) {
    ;[target, title, authorsArg] = args
  } else {
    ;[title, authorsArg] = args
  }

  if (!title?.trim()) {
    throw new Error(
      'usage: pnpm tsx src/set-book-meta.ts <asin|outDir> "<title>" "<author[,author2]>"'
    )
  }

  const authorList = (authorsArg ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

  let outDir: string
  if (target && looksLikePath(target)) {
    outDir = path.resolve(target)
  } else {
    const asin = target || getEnv('ASIN')
    if (!asin) {
      throw new Error(
        'no book specified: pass an ASIN or out dir as the first argument, or set ASIN in .env'
      )
    }
    outDir = await resolveOutDir(asin)
  }

  const written = await setBookMeta(outDir, title.trim(), authorList)
  console.warn(
    `✓ Wrote meta (title=${JSON.stringify(title.trim())}, authors=${JSON.stringify(
      authorList
    )}) → ${written}`
  )
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main()
  } catch (err) {
    reportFatalError('set-book-meta failed', err)
    process.exit(1)
  }
}
