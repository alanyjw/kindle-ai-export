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

async function writePdfBook(
  toc: TocItem[],
  content: ContentChunk[]
): Promise<string> {
  const metadata: Pick<BookMetadata, 'source' | 'toc' | 'pages'> = {
    source: 'pdf',
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
    pdfBasename: 'Example Book',
    useFileLogger: false
  })
  return fs.readFile(markdownPath, 'utf8')
}

function pdfChunk(page: number, text: string): ContentChunk {
  return { index: page - 1, page, text, screenshot: `pdf:/b.pdf#page=${page}` }
}

describe('exportBookMarkdown (pdf mode)', () => {
  it('renders outline entries as nested markdown headings', async () => {
    const toc: TocItem[] = [
      { title: 'PART I | BEGINNINGS', page: 2, level: 0, total: 6 },
      { title: '1 | First Steps', page: 3, level: 1, total: 6 },
      { title: '2 | Second Steps', page: 5, level: 1, total: 6 }
    ]
    const content: ContentChunk[] = [
      pdfChunk(1, 'Front cover matter.'),
      pdfChunk(2, 'O PART I BEGINNINGS ur journey starts here.'),
      pdfChunk(3, 'H First Steps ow do you begin? Like this.'),
      pdfChunk(4, 'More of the first chapter.'),
      pdfChunk(5, 'W Second Steps hat comes next? This does.')
    ]

    const md = await writePdfBook(toc, content)

    expect(md).toMatch(/^# Example Book$/m)
    expect(md).toMatch(/^## PART I \| BEGINNINGS$/m)
    expect(md).toMatch(/^### 1 \| First Steps$/m)
    expect(md).toMatch(/^### 2 \| Second Steps$/m)
    // Parts stay at ##; chapters nest one deeper.
    expect(md).not.toMatch(/^## 1 \| First Steps$/m)
  })

  it('strips the echoed heading and repairs the split drop cap', async () => {
    const toc: TocItem[] = [
      { title: '1 | First Steps', page: 1, level: 0, total: 2 }
    ]
    const content = [pdfChunk(1, 'H First Steps ow do you begin? Like this.')]

    const md = await writePdfBook(toc, content)

    expect(md).toContain('## 1 | First Steps\n\nHow do you begin? Like this.')
    expect(md).not.toContain('H First Steps ow')
  })

  it('keeps content before the first outline entry', async () => {
    const toc: TocItem[] = [{ title: 'Chapter 1', page: 3, level: 0, total: 4 }]
    const content = [
      pdfChunk(1, 'Cover page text.'),
      pdfChunk(2, 'Copyright page text.'),
      pdfChunk(3, 'Chapter 1 body text.')
    ]

    const md = await writePdfBook(toc, content)

    expect(md).toContain('Cover page text.')
    expect(md).toContain('Copyright page text.')
    expect(md).toContain('## Chapter 1')
  })

  it('runs the final outline entry through to the end of the book', async () => {
    const toc: TocItem[] = [
      { title: 'Chapter 1', page: 1, level: 0, total: 4 },
      { title: 'Chapter 2', page: 2, level: 0, total: 4 }
    ]
    const content = [
      pdfChunk(1, 'First chapter text.'),
      pdfChunk(2, 'Second chapter opening.'),
      pdfChunk(3, 'Second chapter continues.'),
      pdfChunk(4, 'The closing words of the book.')
    ]

    const md = await writePdfBook(toc, content)

    expect(md).toContain('The closing words of the book.')
  })

  it('emits a linked table of contents', async () => {
    const toc: TocItem[] = [
      { title: 'PART I | BEGINNINGS', page: 1, level: 0, total: 2 },
      { title: '1 | First Steps', page: 2, level: 1, total: 2 }
    ]
    const content = [pdfChunk(1, 'Part text.'), pdfChunk(2, 'Chapter text.')]

    const md = await writePdfBook(toc, content)

    expect(md).toContain('## Table of Contents')
    expect(md).toContain('- [PART I | BEGINNINGS](#part-i-beginnings)')
    expect(md).toContain('  - [1 | First Steps](#1-first-steps)')
  })

  it('falls back to one unsectioned blob when there is no metadata.json', async () => {
    await fs.writeFile(
      path.join(outDir, 'content.json'),
      JSON.stringify([pdfChunk(1, 'Chapter 1 The only text.')])
    )

    const { markdownPath, mode } = await exportBookMarkdown({
      outDir,
      pdfBasename: 'Example Book',
      useFileLogger: false
    })
    const md = await fs.readFile(markdownPath, 'utf8')

    expect(mode).toBe('content-only')
    expect(md).toContain('# Example Book')
    expect(md).toContain('The only text.')
    expect(md).not.toContain('## Table of Contents')
  })
})

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
