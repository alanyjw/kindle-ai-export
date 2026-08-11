import { describe, expect, it, vi } from 'vitest'

import { capturePageImage, MAX_RETAINED_BLOBS } from '../page-image-capture'
import { blobRetentionInitScript } from '../page-image-capture'

describe('blobRetentionInitScript', () => {
  // Simulates the page's URL object so the hook can be driven directly. The
  // real script runs in the browser's main world, which unit tests can't
  // reach — but its retention bookkeeping is plain logic and worth pinning.
  function pageUrlHarness() {
    const revoked: string[] = []
    let nextId = 0

    const url = {
      createObjectURL: (blob: { type: string }) =>
        `blob:https://read.amazon.com/${blob.type}-${nextId++}`,
      revokeObjectURL: (u: string) => {
        revoked.push(u)
      }
    }

    const original = globalThis.URL
    globalThis.URL = url as unknown as typeof URL
    try {
      blobRetentionInitScript()
      return { url: globalThis.URL as unknown as typeof url, revoked }
    } finally {
      globalThis.URL = original
    }
  }

  it('defers revoking image blobs so they stay readable', () => {
    const { url, revoked } = pageUrlHarness()

    const image = url.createObjectURL({ type: 'image/png' })
    url.revokeObjectURL(image)

    expect(revoked).toEqual([])
  })

  // Non-image blobs must revoke immediately, or the reader's other object URLs
  // would crowd the retention window and evict the pages we actually need.
  it('revokes non-image blobs immediately', () => {
    const { url, revoked } = pageUrlHarness()

    const font = url.createObjectURL({ type: 'font/woff2' })
    url.revokeObjectURL(font)

    expect(revoked).toEqual([font])
  })

  it('revokes an unknown url immediately', () => {
    const { url, revoked } = pageUrlHarness()

    url.revokeObjectURL('blob:https://read.amazon.com/never-created')

    expect(revoked).toEqual(['blob:https://read.amazon.com/never-created'])
  })

  // Each retained blob is a full-page PNG, so the page would grow without
  // bound across a long book if the reader's revokes were simply ignored.
  it('eventually revokes the oldest image past the retention cap', () => {
    const { url, revoked } = pageUrlHarness()

    const images = Array.from({ length: MAX_RETAINED_BLOBS + 3 }, () =>
      url.createObjectURL({ type: 'image/png' })
    )
    for (const image of images) url.revokeObjectURL(image)

    expect(revoked).toEqual(images.slice(0, 3))
  })

  it('still returns the real object url to the caller', () => {
    const { url } = pageUrlHarness()

    expect(url.createObjectURL({ type: 'image/png' })).toMatch(/^blob:/)
  })
})

describe('capturePageImage', () => {
  const screenshotBuffer = Buffer.from('screenshot-bytes')
  const pngBytes = Buffer.from('real-png-bytes')

  // `normalize` stands in for the sharp downscale; identity keeps assertions
  // about *which* path ran readable.
  function harness(
    overrides: Partial<Parameters<typeof capturePageImage>[0]> = {}
  ) {
    const screenshot = vi.fn(async () => screenshotBuffer)
    const normalize = vi.fn(async (buf: Buffer) => buf)
    return {
      screenshot,
      normalize,
      opts: {
        src: 'blob:https://read.amazon.com/abc',
        fetchBlob: async () => pngBytes.toString('base64'),
        screenshot,
        normalize,
        ...overrides
      }
    }
  }

  it('returns the decoded blob when the page still has it', async () => {
    const { opts, screenshot, normalize } = harness()

    const result = await capturePageImage(opts)

    expect(result.source).toBe('blob')
    expect(result.buffer).toEqual(pngBytes)
    expect(normalize).toHaveBeenCalledOnce()
    expect(screenshot).not.toHaveBeenCalled()
  })

  it('passes the element src through to the blob read', async () => {
    const fetchBlob = vi.fn(async () => pngBytes.toString('base64'))
    const { opts } = harness({ fetchBlob })

    await capturePageImage(opts)

    expect(fetchBlob).toHaveBeenCalledWith('blob:https://read.amazon.com/abc')
  })

  // The reader revokes aggressively; a page whose blob aged out of the
  // retention window must still be captured, just less sharply.
  it('falls back to a screenshot when the blob is gone', async () => {
    const { opts, screenshot } = harness({ fetchBlob: async () => undefined })

    const result = await capturePageImage(opts)

    expect(result.source).toBe('screenshot')
    expect(result.buffer).toEqual(screenshotBuffer)
    expect(screenshot).toHaveBeenCalledOnce()
  })

  it('falls back to a screenshot when the in-page read throws', async () => {
    const { opts, screenshot } = harness({
      fetchBlob: async () => {
        throw new Error('frame detached')
      }
    })

    expect((await capturePageImage(opts)).source).toBe('screenshot')
    expect(screenshot).toHaveBeenCalledOnce()
  })

  // A non-blob src means the reader isn't using object URLs at all — skip
  // straight to the screenshot instead of a pointless round trip.
  it('screenshots a non-blob src without reading the page', async () => {
    const fetchBlob = vi.fn(async () => undefined)
    const { opts } = harness({
      src: 'https://read.amazon.com/rendered.png',
      fetchBlob
    })

    expect((await capturePageImage(opts)).source).toBe('screenshot')
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('screenshots when src is missing', async () => {
    const fetchBlob = vi.fn(async () => undefined)
    const { opts } = harness({ src: null, fetchBlob })

    expect((await capturePageImage(opts)).source).toBe('screenshot')
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('falls back to a screenshot when normalizing the blob fails', async () => {
    const { opts, screenshot } = harness({
      normalize: async () => {
        throw new Error('sharp exploded')
      }
    })

    expect((await capturePageImage(opts)).source).toBe('screenshot')
    expect(screenshot).toHaveBeenCalledOnce()
  })

  it('reports why a fallback happened', async () => {
    const onFallback = vi.fn()
    const { opts } = harness({ fetchBlob: async () => undefined, onFallback })

    await capturePageImage(opts)

    expect(onFallback).toHaveBeenCalledWith('blob-unavailable')
  })

  it('propagates a screenshot failure once both paths are exhausted', async () => {
    const { opts } = harness({
      fetchBlob: async () => undefined,
      screenshot: async () => {
        throw new Error('detached')
      }
    })

    await expect(capturePageImage(opts)).rejects.toThrow('detached')
  })
})
