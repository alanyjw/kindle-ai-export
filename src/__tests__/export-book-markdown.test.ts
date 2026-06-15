import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportBookMarkdown } from '../export-book-markdown'
import type { BookMetadata, ContentChunk, TocItem } from '../types'

let outDir: string

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kae-md-'))
})

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true })
})

async function writeBook(
  toc: TocItem[],
  content: ContentChunk[]
): Promise<string> {
  const metadata: Pick<BookMetadata, 'meta' | 'toc' | 'pages'> = {
    meta: {
      title: 'Test Book',
      authorList: ['Test Author']
    } as BookMetadata['meta'],
    toc,
    pages: []
  }
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(metadata)
  )
  await fs.writeFile(path.join(outDir, 'content.json'), JSON.stringify(content))

  const { markdownPath } = await exportBookMarkdown({
    outDir,
    useFileLogger: false
  })
  return fs.readFile(markdownPath, 'utf8')
}

function chunk(index: number, page: number, text: string): ContentChunk {
  return { index, page, text, screenshot: `${page}.png` }
}

describe('exportBookMarkdown (kindle mode)', () => {
  it('regression: includes the final TOC section through end of content', () => {
    // The old loop iterated `i < toc.length - 1`, dropping the last TOC entry —
    // so the final chapter and everything after its start page (e.g. the book's
    // conclusion) never made it into the markdown.
    const toc: TocItem[] = [
      { title: 'Chapter 1', page: 1, total: 10 },
      { title: 'Chapter 2', page: 5, total: 10 },
      { title: 'Final Chapter', page: 8, total: 10 }
    ]
    const content: ContentChunk[] = [
      chunk(0, 1, 'Opening of chapter one.'),
      chunk(1, 5, 'Middle of chapter two.'),
      chunk(2, 8, 'Start of the final chapter.'),
      chunk(3, 10, 'The closing words of the book.')
    ]

    return writeBook(toc, content).then((md) => {
      expect(md).toContain('## Final Chapter')
      expect(md).toContain('Start of the final chapter.')
      // Content past the final chapter's start page must not be dropped.
      expect(md).toContain('The closing words of the book.')
    })
  })

  it('still renders earlier sections bounded by the next TOC entry', async () => {
    const toc: TocItem[] = [
      { title: 'Chapter 1', page: 1, total: 10 },
      { title: 'Chapter 2', page: 5, total: 10 }
    ]
    const content: ContentChunk[] = [
      chunk(0, 1, 'Alpha content.'),
      chunk(1, 5, 'Beta content.')
    ]

    const md = await writeBook(toc, content)
    expect(md).toContain('## Chapter 1')
    expect(md).toContain('Alpha content.')
    expect(md).toContain('## Chapter 2')
    expect(md).toContain('Beta content.')
  })
})
