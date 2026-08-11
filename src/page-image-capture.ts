/**
 * Page image capture for the Kindle web reader.
 *
 * The reader renders each screen into a PNG `Blob`, hands the page a `blob:`
 * object URL for it, and revokes that URL as soon as the image is displayed.
 * Screenshotting the `<img>` therefore never reads Amazon's actual bytes — it
 * re-rasterizes whatever the compositor happens to be showing, at whatever
 * scale the screenshot was asked for.
 *
 * Reading the blob itself gives us the renderer's original PNG, which is what
 * the OCR step ultimately reads.
 *
 * The mechanism is shaped by how Patchright isolates worlds:
 *
 * - Init scripts run in the page's **main world**, so a `URL` hook installed
 *   there does intercept the reader's own calls.
 * - `exposeBinding` installs its function in the **isolated** world, so
 *   main-world code cannot call it — a binding-based handoff silently captures
 *   nothing.
 * - `page.evaluate` runs in the isolated world, which shares the page's origin
 *   and *can* `fetch()` a main-world `blob:` URL — but only while it is alive.
 *
 * So the init script's only job is to keep image blob URLs alive past the
 * reader's revoke, and Node reads them directly. Every path degrades to a
 * screenshot rather than failing: a reader change that breaks retention should
 * cost image quality, not the whole extraction.
 */

/**
 * How many revoked image blobs the page keeps alive. Each is a full-page PNG,
 * so this is a memory/robustness tradeoff: enough slack that a page is still
 * readable a few screens after it rendered, far short of a whole book.
 *
 * Kept in sync by hand with the literal inside {@link blobRetentionInitScript}
 * — init scripts are serialized without their closure, so the constant cannot
 * be referenced from there.
 */
export const MAX_RETAINED_BLOBS = 8

/**
 * Runs in the page (via an init script) before any reader code.
 *
 * Wraps `URL.createObjectURL` to note which object URLs are images, and
 * `URL.revokeObjectURL` to defer revoking those — keeping a bounded number
 * alive so the extractor can still read them. Non-image blobs revoke normally,
 * which keeps the reader's other object URLs from crowding out the pages.
 */
export function blobRetentionInitScript(): void {
  // NOTE: no closure — init scripts are serialized as source. Keep this
  // literal in sync with MAX_RETAINED_BLOBS.
  const maxRetained = 8

  const originalCreateObjectURL = URL.createObjectURL.bind(URL)
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)

  const imageUrls = new Set<string>()
  const retained: string[] = []

  // Typed against Node's `URL` (this project has no full `dom` lib), but only
  // ever runs in the page, where the argument may also be a `MediaSource` —
  // hence the defensive `type` read rather than trusting the signature.
  URL.createObjectURL = function (obj: Blob): string {
    const url = originalCreateObjectURL(obj)
    if (obj?.type?.startsWith('image/')) {
      imageUrls.add(url)
    }

    return url
  }

  URL.revokeObjectURL = function (url: string): void {
    if (!imageUrls.has(url)) {
      originalRevokeObjectURL(url)
      return
    }

    // Defer: the extractor still needs these bytes. Honour the reader's
    // revoke eventually, oldest first, so page memory stays bounded.
    retained.push(url)
    while (retained.length > maxRetained) {
      const oldest = retained.shift()
      if (oldest === undefined) break
      imageUrls.delete(oldest)
      originalRevokeObjectURL(oldest)
    }
  }
}

/**
 * Runs in the isolated world (via `page.evaluate`). Reads a still-live
 * `blob:` URL and returns it base64-encoded, or `undefined` if the URL has
 * already been revoked.
 */
export async function fetchBlobAsBase64InPage(
  url: string
): Promise<string | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) return undefined

    // Byte-at-a-time rather than spreading into `fromCharCode(...bytes)`,
    // which blows the argument limit on a full-page PNG.
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }

    return btoa(binary)
  } catch {
    return undefined
  }
}

export type PageImageSource = 'blob' | 'screenshot'

/** Why a capture fell back to screenshotting the element. */
export type PageImageFallbackReason =
  | 'no-src'
  | 'not-a-blob-url'
  | 'blob-unavailable'
  | 'normalize-failed'

export interface CapturedPageImage {
  buffer: Buffer
  source: PageImageSource
}

export interface CapturePageImageOptions {
  /** Current `src` of the reader's rendered image element. */
  src: string | null | undefined
  /** Reads the blob at `src` from the page, base64-encoded. */
  fetchBlob: (src: string) => Promise<string | undefined>
  /** Fallback: screenshot the rendered image element. */
  screenshot: () => Promise<Buffer>
  /** Post-process raw blob bytes (e.g. downscale to CSS pixels). */
  normalize: (buffer: Buffer) => Promise<Buffer>
  onFallback?: (reason: PageImageFallbackReason) => void
}

/**
 * Capture the currently rendered page image, preferring the reader's own PNG
 * blob and falling back to a screenshot.
 */
export async function capturePageImage({
  src,
  fetchBlob,
  screenshot,
  normalize,
  onFallback
}: CapturePageImageOptions): Promise<CapturedPageImage> {
  async function fallback(
    reason: PageImageFallbackReason
  ): Promise<CapturedPageImage> {
    onFallback?.(reason)
    return { buffer: await screenshot(), source: 'screenshot' }
  }

  if (!src) return fallback('no-src')

  // Only object URLs can be read back this way; anything else (a data: or
  // http: src) should go straight to the screenshot path.
  if (!src.startsWith('blob:')) return fallback('not-a-blob-url')

  let base64: string | undefined
  try {
    base64 = await fetchBlob(src)
  } catch {
    // An evaluate that throws (navigation mid-read, detached frame) is just
    // another unavailable blob.
    base64 = undefined
  }

  if (!base64) return fallback('blob-unavailable')

  try {
    return {
      buffer: await normalize(Buffer.from(base64, 'base64')),
      source: 'blob'
    }
  } catch {
    return fallback('normalize-failed')
  }
}
