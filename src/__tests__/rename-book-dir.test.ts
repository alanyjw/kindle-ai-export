import { describe, expect, it, vi } from 'vitest'

import {
  bookDirName,
  looksLikeBareAsinDir,
  renameBookDir,
  rewriteOutDirPath,
  rewriteScreenshotRefs
} from '../rename-book-dir'

describe('bookDirName', () => {
  it('joins the asin and a sanitized title', () => {
    expect(bookDirName('ASIN000001', 'Example Book')).toBe(
      'ASIN000001-Example Book'
    )
  })

  // Must match extraction's own naming exactly, or a late rename would move a
  // book to a different name than the early rename would have produced.
  it('strips characters that are illegal in directory names', () => {
    expect(bookDirName('ASIN000001', 'Example: A/Book?')).toBe(
      'ASIN000001-Example ABook'
    )
  })

  it('returns undefined for a title that is only whitespace', () => {
    expect(bookDirName('ASIN000001', '   ')).toBeUndefined()
  })

  it('returns undefined for a missing title', () => {
    expect(bookDirName('ASIN000001', undefined)).toBeUndefined()
  })
})

describe('rewriteOutDirPath', () => {
  it('repoints a path that lives under the renamed directory', () => {
    expect(
      rewriteOutDirPath(
        'out/ASIN000001/pages/000-001.png',
        'ASIN000001',
        'ASIN000001-Example Book'
      )
    ).toBe('out/ASIN000001-Example Book/pages/000-001.png')
  })

  it('rewrites front-matter paths too', () => {
    expect(
      rewriteOutDirPath(
        'out/ASIN000001/front-matter/00-title-page.png',
        'ASIN000001',
        'ASIN000001-Example Book'
      )
    ).toBe('out/ASIN000001-Example Book/front-matter/00-title-page.png')
  })

  // PDF/EPUB provenance markers are not filesystem paths into the out dir.
  // Rewriting one would destroy the only record of where the book came from.
  it('leaves a pdf provenance marker untouched', () => {
    const ref = 'pdf:/Users/someone/Books/example.pdf#page=12'
    expect(rewriteOutDirPath(ref, 'ASIN000001', 'ASIN000001-Example')).toBe(ref)
  })

  it('leaves a different book’s directory untouched', () => {
    const ref = 'out/ASIN000002/pages/000-001.png'
    expect(rewriteOutDirPath(ref, 'ASIN000001', 'ASIN000001-Example')).toBe(ref)
  })

  // A prefix match would corrupt a sibling whose name merely starts the same.
  it('does not treat a name-prefix as a match', () => {
    const ref = 'out/ASIN0000011/pages/000-001.png'
    expect(rewriteOutDirPath(ref, 'ASIN000001', 'ASIN000001-Example')).toBe(ref)
  })

  it('leaves a path outside out/ untouched', () => {
    const ref = 'other/ASIN000001/pages/000-001.png'
    expect(rewriteOutDirPath(ref, 'ASIN000001', 'ASIN000001-Example')).toBe(ref)
  })
})

describe('rewriteScreenshotRefs', () => {
  it('rewrites every chunk without mutating the input', () => {
    const content = [
      { index: 0, screenshot: 'out/ASIN000001/pages/000-001.png' },
      { index: 1, screenshot: 'out/ASIN000001/pages/001-002.png' }
    ]
    const frozen = JSON.stringify(content)

    const { value, rewritten } = rewriteScreenshotRefs(
      content,
      'ASIN000001',
      'ASIN000001-Example Book'
    )

    expect(rewritten).toBe(2)
    expect(value[0]!.screenshot).toBe(
      'out/ASIN000001-Example Book/pages/000-001.png'
    )
    expect(JSON.stringify(content)).toBe(frozen)
  })

  it('reaches nested pages and frontMatter arrays', () => {
    const metadata = {
      pages: [{ index: 0, screenshot: 'out/ASIN000001/pages/000-001.png' }],
      frontMatter: [
        {
          title: 'Title Page',
          screenshot: 'out/ASIN000001/front-matter/00-title-page.png'
        }
      ],
      meta: { title: 'Example Book' }
    }

    const { value, rewritten } = rewriteScreenshotRefs(
      metadata,
      'ASIN000001',
      'ASIN000001-Example Book'
    )

    expect(rewritten).toBe(2)
    expect(value.pages[0]!.screenshot).toBe(
      'out/ASIN000001-Example Book/pages/000-001.png'
    )
    expect(value.frontMatter[0]!.screenshot).toBe(
      'out/ASIN000001-Example Book/front-matter/00-title-page.png'
    )
    // Untouched fields survive verbatim.
    expect(value.meta.title).toBe('Example Book')
  })

  it('counts nothing when there is no matching path', () => {
    const { rewritten } = rewriteScreenshotRefs(
      [{ screenshot: 'pdf:/tmp/example.pdf#page=1' }],
      'ASIN000001',
      'ASIN000001-Example'
    )
    expect(rewritten).toBe(0)
  })
})

describe('renameBookDir', () => {
  function harness(
    files: Record<string, unknown>,
    overrides: Record<string, unknown> = {}
  ) {
    const store = new Map<string, string>(
      Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)])
    )
    const renames: Array<[string, string]> = []

    const deps = {
      readFile: vi.fn(async (p: string) => {
        const hit = store.get(p)
        if (hit === undefined) throw new Error(`ENOENT: ${p}`)
        return hit
      }),
      writeFile: vi.fn(async (p: string, data: string) => {
        store.set(p, data)
      }),
      rename: vi.fn(async (from: string, to: string) => {
        renames.push([from, to])
      }),
      exists: vi.fn(async () => false),
      ...overrides
    }
    return { deps, store, renames }
  }

  const metadata = {
    meta: { title: 'Example Book' },
    pages: [{ index: 0, screenshot: 'out/ASIN000001/pages/000-001.png' }],
    frontMatter: [
      {
        title: 'Title Page',
        screenshot: 'out/ASIN000001/front-matter/00-title-page.png'
      }
    ]
  }
  const content = [{ index: 0, screenshot: 'out/ASIN000001/pages/000-001.png' }]

  it('renames the directory and repoints every recorded path', async () => {
    const { deps, store, renames } = harness({
      'out/ASIN000001/metadata.json': metadata,
      'out/ASIN000001/content.json': content
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(true)
    expect(result.to).toBe('out/ASIN000001-Example Book')
    expect(renames).toEqual([['out/ASIN000001', 'out/ASIN000001-Example Book']])
    // Rewrites are written to the NEW location — the old one no longer exists.
    const written = JSON.parse(
      store.get('out/ASIN000001-Example Book/content.json')!
    ) as Array<{ screenshot: string }>
    expect(written[0]!.screenshot).toBe(
      'out/ASIN000001-Example Book/pages/000-001.png'
    )
    expect(result.rewritten).toBe(3)
  })

  it('does nothing when the directory is already correctly named', async () => {
    const { deps, renames } = harness({
      'out/ASIN000001-Example Book/metadata.json': metadata,
      'out/ASIN000001-Example Book/content.json': content
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001-Example Book', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('already named')
    expect(renames).toEqual([])
  })

  // A PDF/EPUB out-dir is named after its source file and carries `source`.
  // EPUB metadata also carries a `meta.title`, so without this guard a book
  // whose directory name happened to be 10 characters would be renamed to
  // `<filename>-<title>`. Real risk, not hypothetical.
  it('refuses to rename a PDF-sourced book', async () => {
    const { deps, renames } = harness({
      'out/ASIN000001/metadata.json': { ...metadata, source: 'pdf' }
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('not a kindle book')
    expect(renames).toEqual([])
  })

  it('refuses to rename an EPUB-sourced book', async () => {
    const { deps, renames } = harness({
      'out/ASIN000001/metadata.json': { ...metadata, source: 'epub' }
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('not a kindle book')
    expect(renames).toEqual([])
  })

  it('does nothing when no title has been recovered', async () => {
    const { deps, renames } = harness({
      'out/ASIN000001/metadata.json': { pages: [] },
      'out/ASIN000001/content.json': content
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('no title')
    expect(renames).toEqual([])
  })

  // Clobbering a populated directory would silently destroy another export.
  it('refuses to rename onto an existing directory', async () => {
    const { deps, renames } = harness(
      {
        'out/ASIN000001/metadata.json': metadata,
        'out/ASIN000001/content.json': content
      },
      { exists: vi.fn(async () => true) }
    )

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('target exists')
    expect(renames).toEqual([])
  })

  it('reports without touching the filesystem in dry-run mode', async () => {
    const { deps, renames, store } = harness({
      'out/ASIN000001/metadata.json': metadata,
      'out/ASIN000001/content.json': content
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001', dryRun: true },
      deps as any
    )

    expect(result.renamed).toBe(true)
    expect(result.to).toBe('out/ASIN000001-Example Book')
    expect(result.rewritten).toBe(3)
    expect(renames).toEqual([])
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(store.has('out/ASIN000001/metadata.json')).toBe(true)
  })

  // A book transcribed but never exported has no content.json yet; the rename
  // should still work rather than failing on the missing file.
  it('tolerates a missing content.json', async () => {
    const { deps, renames } = harness({
      'out/ASIN000001/metadata.json': metadata
    })

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(true)
    expect(renames).toHaveLength(1)
    expect(result.rewritten).toBe(2)
  })

  it('does nothing when there is no metadata.json at all', async () => {
    const { deps, renames } = harness({})

    const result = await renameBookDir(
      { outDir: 'out/ASIN000001', asin: 'ASIN000001' },
      deps as any
    )

    expect(result.renamed).toBe(false)
    expect(result.reason).toBe('no metadata')
    expect(renames).toEqual([])
  })
})

describe('looksLikeBareAsinDir', () => {
  it('accepts a bare 10-character asin', () => {
    expect(looksLikeBareAsinDir('ASIN000001')).toBe(true)
  })

  it('rejects a directory that already carries a title', () => {
    expect(looksLikeBareAsinDir('ASIN000001-Example Book')).toBe(false)
  })

  // PDF/EPUB out-dirs are named after the source file. Renaming one would
  // give it an ASIN prefix it should never have.
  it('rejects a PDF-sourced directory name', () => {
    expect(looksLikeBareAsinDir('example-book')).toBe(false)
    expect(looksLikeBareAsinDir('Example Book')).toBe(false)
  })

  it('rejects names of the wrong length', () => {
    expect(looksLikeBareAsinDir('ASIN00001')).toBe(false)
    expect(looksLikeBareAsinDir('ASIN0000011')).toBe(false)
  })
})
