import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { EPub } from 'epub2'
import { afterAll, describe, expect, it } from 'vitest'

import {
  isExternalLink,
  isPromotableHeading,
  sectionHtmlToMarkdown
} from '../epub-markdown'
import { normalizeAuthors } from '../epub'
import { humanizeSpineId } from '../epub-sections'
import { extractEpub } from '../epub-transcribe'
import { verifyBookContent } from '../verify-book-content'
import { buildFixtureEpub, containerXml } from './helpers/build-fixture-epub'
import { fixtureA, fixtureB } from './fixtures/epub-fixtures'

const tmpDirs: string[] = []
async function tmpOut(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-out-'))
  tmpDirs.push(d)
  return d
}

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }))
  )
})

describe('isExternalLink', () => {
  it('keeps http/https/mailto/tel, treats everything else as intra', () => {
    expect(isExternalLink('https://example.com')).toBe(true)
    expect(isExternalLink('http://x.org')).toBe(true)
    expect(isExternalLink('mailto:a@b.c')).toBe(true)
    expect(isExternalLink('tel:+1')).toBe(true)
    expect(isExternalLink('chapter2.xhtml#x')).toBe(false)
    expect(isExternalLink('#note3')).toBe(false)
    expect(isExternalLink('../ch2.xhtml')).toBe(false)
    expect(isExternalLink('epub:foo')).toBe(false)
  })
})

describe('isPromotableHeading', () => {
  it('accepts real and numeric titles, rejects junk', () => {
    expect(isPromotableHeading('The Funeral')).toBe(true)
    expect(isPromotableHeading('1984')).toBe(true)
    expect(isPromotableHeading('1: The Beginning')).toBe(true)
    expect(isPromotableHeading('P')).toBe(false) // drop-cap
    expect(isPromotableHeading('')).toBe(false)
    expect(isPromotableHeading('—')).toBe(false)
    expect(isPromotableHeading('***')).toBe(false)
  })
})

describe('normalizeAuthors', () => {
  it('strips trailing semicolons, splits multiples, de-dupes', () => {
    expect(normalizeAuthors('Addy Osmani;')).toEqual(['Addy Osmani'])
    expect(normalizeAuthors('Ada; Bee')).toEqual(['Ada', 'Bee'])
    expect(normalizeAuthors('Ada; Ada')).toEqual(['Ada'])
    expect(normalizeAuthors('')).toEqual([])
    expect(normalizeAuthors(undefined)).toEqual([])
  })
})

describe('humanizeSpineId', () => {
  it('turns front-matter spine ids into human labels', () => {
    expect(humanizeSpineId('cover')).toBe('Cover')
    expect(humanizeSpineId('titlepage-id212')).toBe('Titlepage')
    expect(humanizeSpineId('copyright-page-id213')).toBe('Copyright Page')
    expect(humanizeSpineId('id999')).toBe('') // nothing meaningful left
  })
})

describe('sectionHtmlToMarkdown', () => {
  const noImages = { resolveImage: () => null }

  it('strips the promoted leading heading and demotes the rest to h3', () => {
    const html = '<h1>Chapter Title</h1><p>Body.</p><h2>Sub</h2><p>More.</p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: true,
      ...noImages
    })
    expect(md).not.toContain('# Chapter Title')
    expect(md).toContain('Body.')
    // remaining shallowest heading (h2) demotes to h3
    expect(md).toContain('### Sub')
  })

  it('keeps a non-promoted leading heading when not stripping', () => {
    const html = '<h1>Real</h1><p>Body.</p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: false,
      ...noImages
    })
    // shallowest heading h1 → h3
    expect(md).toContain('### Real')
  })

  it('rewrites images via resolveImage and drops on null', () => {
    const html =
      '<p>A<img src="x/a.png" alt="alt"/></p><p>B<img src="y/b.png" alt="b"/></p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: false,
      resolveImage: (src) => (src === 'x/a.png' ? 'images/a.png' : null)
    })
    expect(md).toContain('![alt](images/a.png)')
    expect(md).not.toContain('b.png')
  })

  it('passes data: URIs through untouched', () => {
    const html = '<p><img src="data:image/png;base64,AAAA" alt="d"/></p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: false,
      resolveImage: () => null
    })
    expect(md).toContain('data:image/png;base64,AAAA')
  })

  it('unwraps intra-EPUB links but keeps external ones', () => {
    const html =
      '<p>see <a href="ch2.xhtml#x">here</a> and <a href="https://ex.com">site</a></p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: false,
      ...noImages
    })
    expect(md).toContain('here') // text kept
    expect(md).not.toContain('ch2.xhtml') // link dropped
    expect(md).toContain('[site](https://ex.com)') // external kept
  })

  it('keeps the image when an intra-link wraps it', () => {
    const html = '<p><a href="ch1.xhtml"><img src="c.png" alt="cover"/></a></p>'
    const md = sectionHtmlToMarkdown(html, {
      stripLeadingHeading: false,
      resolveImage: () => 'images/c.png'
    })
    expect(md).toContain('![cover](images/c.png)')
    expect(md).not.toContain('ch1.xhtml')
  })
})

describe('extractEpub — fixture A (single-file + NCX)', () => {
  it('splits into front + 3 chapters + notes, in order', async () => {
    const epubPath = await buildFixtureEpub(fixtureA(), 'a')
    const out = await tmpOut()
    const { content, metadata } = await extractEpub(epubPath, out)

    expect(content.map((c) => c.text.split('\n')[0])).toBeTruthy()
    // 5 sections: Front Matter, Chapter One, Chapter Two, Chapter Three, Notes
    expect(content.length).toBe(5)
    expect(content.every((c, i) => c.index === i && c.page === i + 1)).toBe(
      true
    )
    expect(content.every((c) => c.screenshot.startsWith('epub:'))).toBe(true)

    const titles = metadata.toc.map((t) => t.title)
    expect(titles.slice(0, 5)).toEqual([
      'Front Matter',
      'Chapter One',
      'Chapter Two',
      'Chapter Three',
      'Notes'
    ])
    // trailing sentinel with no page
    expect(metadata.toc.length).toBe(6)
    expect(metadata.toc.at(-1)!.page).toBeUndefined()
    expect(metadata.pages.length).toBe(5)
    expect(metadata.meta.title).toBe('Fixture A Book')
    expect(metadata.meta.authorList).toEqual(['Ada Author'])
  })

  it('extracts the image and references it; unwraps the footnote link', async () => {
    const epubPath = await buildFixtureEpub(fixtureA(), 'a')
    const out = await tmpOut()
    const { content } = await extractEpub(epubPath, out)

    const ch1 = content[1]!.text
    expect(ch1).toContain('![pic](images/p.png)')
    expect(ch1).toContain('note') // link text kept
    expect(ch1).not.toContain('notes.xhtml') // intra link dropped

    const img = await fs.readFile(path.join(out, 'images', 'p.png'))
    expect(img.length).toBeGreaterThan(0)

    // external link in chapter three retained
    expect(content[3]!.text).toContain('[site](https://example.com)')
  })

  it('does not produce blank-marker chunks for real content', async () => {
    const epubPath = await buildFixtureEpub(fixtureA(), 'a')
    const out = await tmpOut()
    const { content } = await extractEpub(epubPath, out)
    expect(content.some((c) => c.text === '[BLANK_PAGE]')).toBe(false)
  })

  it('verifies clean — no unparseable-screenshot or empty-chapter', async () => {
    const epubPath = await buildFixtureEpub(fixtureA(), 'a')
    const out = await tmpOut()
    const { content, metadata } = await extractEpub(epubPath, out)
    await fs.writeFile(
      path.join(out, 'content.json'),
      JSON.stringify(content, null, 2)
    )
    await fs.writeFile(
      path.join(out, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    )
    const res = await verifyBookContent({ outDir: out, repair: false })
    const kinds = res.issues.map((i) => i.kind)
    expect(kinds).not.toContain('unparseable-screenshot')
    expect(kinds).not.toContain('empty-chapter')
  })
})

describe('extractEpub — front-matter cleanup', () => {
  function frontMatterEpub() {
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="b">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="b">urn:uuid:fm</dc:identifier>
    <dc:title>My Book</dc:title>
    <dc:creator>Jane Doe;</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="titlepage-id212" href="title.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/>
    <itemref idref="titlepage-id212"/>
    <itemref idref="ch1"/>
  </spine>
</package>`
    const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="ch1.xhtml#c1"/></navPoint>
</navMap></ncx>`
    const cover = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Cover artwork placeholder.</p></body></html>`
    // Title page repeats the book title as its only heading.
    const title = `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>My Book</h1><p>by Jane Doe</p></body></html>`
    const ch1 = `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="c1">Chapter 1</h1><p>Real content.</p></body></html>`
    return {
      'META-INF/container.xml': containerXml('content.opf'),
      'content.opf': opf,
      'toc.ncx': ncx,
      'cover.xhtml': cover,
      'title.xhtml': title,
      'ch1.xhtml': ch1
    }
  }

  it('relabels front matter and normalizes the author', async () => {
    const epubPath = await buildFixtureEpub(frontMatterEpub(), 'fm')
    const out = await tmpOut()
    const { metadata } = await extractEpub(epubPath, out)

    expect(metadata.meta.authorList).toEqual(['Jane Doe']) // no trailing ;
    const titles = metadata.toc.map((t) => t.title)
    // cover → humanized label, title page → NOT the book title, chapter kept
    expect(titles.slice(0, 3)).toEqual(['Cover', 'Titlepage', 'Chapter 1'])
    // the book title is never used as a section heading
    expect(titles).not.toContain('My Book')
  })
})

describe('verify isTrailer + sentinel interaction', () => {
  it('does not flag a [BLANK_PAGE] final section as empty-chapter', async () => {
    const out = await tmpOut()
    const content = [
      { index: 0, page: 1, text: 'Real chapter text.', screenshot: 'epub:a' },
      { index: 1, page: 2, text: '[BLANK_PAGE]', screenshot: 'epub:b' }
    ]
    const metadata = {
      info: {},
      meta: { title: 'T', authorList: ['X'] },
      toc: [
        { title: 'A', page: 1, total: 2 },
        { title: 'B', page: 2, total: 2 },
        { title: '', total: 2 } // trailing sentinel (no page)
      ],
      pages: content.map((c) => ({
        index: c.index,
        page: c.page,
        total: 2,
        screenshot: c.screenshot
      }))
    }
    await fs.writeFile(
      path.join(out, 'content.json'),
      JSON.stringify(content, null, 2)
    )
    await fs.writeFile(
      path.join(out, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    )
    const res = await verifyBookContent({ outDir: out, repair: false })
    expect(res.issues.map((i) => i.kind)).not.toContain('empty-chapter')
  })
})

describe('extractEpub — fixture B (nav-only EPUB3)', () => {
  it('epub2 surfaces no NCX toc for nav-only books', async () => {
    const epubPath = await buildFixtureEpub(fixtureB(), 'b')
    const ep = await EPub.createAsync(epubPath)
    expect(((ep as any).toc ?? []).length).toBe(0)
  })

  it('parses nav.xhtml manually into 2 sections', async () => {
    const epubPath = await buildFixtureEpub(fixtureB(), 'b')
    const out = await tmpOut()
    const { content, metadata } = await extractEpub(epubPath, out)
    expect(content.length).toBe(2)
    expect(metadata.toc.slice(0, 2).map((t) => t.title)).toEqual([
      'Part One',
      'Part Two'
    ])
    expect(metadata.meta.authorList).toEqual(['Bee Writer'])
  })
})
