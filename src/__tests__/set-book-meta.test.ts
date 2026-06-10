import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setBookMeta } from '../set-book-meta'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'set-book-meta-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeMetadata(obj: unknown): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'metadata.json'),
    JSON.stringify(obj, null, 2)
  )
}

async function readMetadata(): Promise<any> {
  return JSON.parse(
    await fs.readFile(path.join(tmpDir, 'metadata.json'), 'utf8')
  )
}

describe('setBookMeta', () => {
  it('backfills title and authors while preserving toc and pages', async () => {
    await writeMetadata({
      toc: [{ title: 'Cover', total: 100 }],
      pages: [{ index: 0, page: 1, total: 100, screenshot: 'a.png' }]
    })

    const written = await setBookMeta(tmpDir, 'On Writing Well', [
      'William Zinsser'
    ])
    expect(written).toBe(path.join(tmpDir, 'metadata.json'))

    const updated = await readMetadata()
    expect(updated.meta.title).toBe('On Writing Well')
    expect(updated.meta.authorList).toEqual(['William Zinsser'])
    // Existing data is untouched.
    expect(updated.toc).toHaveLength(1)
    expect(updated.pages).toHaveLength(1)
    expect(updated.pages[0].screenshot).toBe('a.png')
  })

  it('merges into a partial pre-existing meta rather than dropping it', async () => {
    await writeMetadata({
      meta: { asin: 'B0090RVGW0', language: 'english' },
      toc: [{ title: 'Cover', total: 1 }]
    })

    await setBookMeta(tmpDir, 'My Title', ['Author One', 'Author Two'])

    const updated = await readMetadata()
    expect(updated.meta.asin).toBe('B0090RVGW0')
    expect(updated.meta.language).toBe('english')
    expect(updated.meta.title).toBe('My Title')
    expect(updated.meta.authorList).toEqual(['Author One', 'Author Two'])
  })

  it('produces metadata that resolveBookMeta reads back as non-synthesized', async () => {
    await writeMetadata({ toc: [{ title: 'Cover', total: 1 }], pages: [] })
    await setBookMeta(tmpDir, 'Recovered Title', ['Someone'])
    const updated = await readMetadata()

    // The whole point: after backfill the export path no longer needs a fallback.
    const { resolveBookMeta } = await import('../book-meta')
    const resolved = resolveBookMeta(updated, tmpDir)
    expect(resolved.synthesized).toBe(false)
    expect(resolved.title).toBe('Recovered Title')
    expect(resolved.authorList).toEqual(['Someone'])
  })
})
