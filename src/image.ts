import { createCanvas } from '@napi-rs/canvas'

export type BlankPageAnalysis = {
  width: number
  height: number
  samples: number
  whiteRatio: number
  darkRatio: number
  meanLuma: number
  lumaStddev: number
}

export type BlankPageOptions = {
  /**
   * Ratio of pixels that must be near-white to consider the page blank.
   * Default: 0.95
   */
  whiteRatioThreshold?: number

  /**
   * Luma threshold (0-255) to count as "near-white".
   * Default: 245
   */
  whiteLuma?: number

  /**
   * Luma threshold (0-255) to count as "near-black/ink".
   * Default: 30
   */
  blackLuma?: number

  /**
   * Maximum allowed ratio of near-black pixels to still consider the page blank.
   * Default: 0.002
   */
  darkRatioMax?: number

  /**
   * Percentage (0-0.49) of the image to crop from each side before sampling.
   * Useful to ignore borders/shadows.
   * Default: 0.02
   */
  cropPct?: number

  /**
   * Sampling step in pixels over the (downscaled) image.
   * 1 means sample every pixel.
   * Default: 4
   */
  sampleStep?: number

  /**
   * Maximum dimension (px) to downscale the image to before sampling.
   * Default: 512
   */
  maxDimension?: number

  /**
   * Optional extra guardrail: if provided, require lumaStddev <= this value
   * to consider the page blank.
   */
  lumaStddevMax?: number
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function toInt255(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.round(n), 0, 255)
}

async function loadImageFromBuffer(buf: Buffer): Promise<any> {
  // @napi-rs/canvas provides loadImage at runtime, but its TS types may not export it.
  // Use a dynamic import shim to keep strict typechecking happy.
  const mod: any = await import('@napi-rs/canvas')
  const loadImage: any = mod?.loadImage ?? mod?.default?.loadImage
  if (typeof loadImage !== 'function') {
    throw new TypeError(
      'Unable to load image: @napi-rs/canvas.loadImage is not available'
    )
  }
  return loadImage(buf)
}

export async function analyzeBlankPageFromPng(
  png: Buffer,
  opts: BlankPageOptions = {}
): Promise<BlankPageAnalysis> {
  const img = await loadImageFromBuffer(png)

  const maxDimension = Math.max(16, Math.floor(opts.maxDimension ?? 512))
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img as any, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  const cropPct = clamp(opts.cropPct ?? 0.02, 0, 0.49)
  const x0 = Math.floor(width * cropPct)
  const y0 = Math.floor(height * cropPct)
  const x1 = Math.max(x0 + 1, Math.ceil(width * (1 - cropPct)))
  const y1 = Math.max(y0 + 1, Math.ceil(height * (1 - cropPct)))

  const step = Math.max(1, Math.floor(opts.sampleStep ?? 4))
  const whiteLuma = toInt255(Number(opts.whiteLuma), 245)
  const blackLuma = toInt255(Number(opts.blackLuma), 30)

  let samples = 0
  let white = 0
  let dark = 0
  let sum = 0
  let sumSq = 0

  // Luma approximation (sRGB): favors green, cheap enough for sampling.
  // Ignore fully transparent pixels (shouldn't happen for PNG screenshots, but safe).
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4
      const a = data[i + 3]!
      if (a === 0) continue

      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b

      samples++
      sum += luma
      sumSq += luma * luma

      if (luma >= whiteLuma) white++
      if (luma <= blackLuma) dark++
    }
  }

  const safeSamples = Math.max(1, samples)
  const meanLuma = sum / safeSamples
  const variance = Math.max(0, sumSq / safeSamples - meanLuma * meanLuma)
  const lumaStddev = Math.sqrt(variance)

  return {
    width,
    height,
    samples,
    whiteRatio: white / safeSamples,
    darkRatio: dark / safeSamples,
    meanLuma,
    lumaStddev
  }
}

export async function isBlankPageFromPng(
  png: Buffer,
  opts: BlankPageOptions = {}
): Promise<{ isBlank: boolean; analysis: BlankPageAnalysis }> {
  const analysis = await analyzeBlankPageFromPng(png, opts)

  const whiteRatioThreshold = clamp(opts.whiteRatioThreshold ?? 0.95, 0, 1)
  const darkRatioMax = clamp(opts.darkRatioMax ?? 0.002, 0, 1)

  const basic =
    analysis.whiteRatio >= whiteRatioThreshold &&
    analysis.darkRatio <= darkRatioMax

  const stddevOk =
    opts.lumaStddevMax === undefined ||
    analysis.lumaStddev <= opts.lumaStddevMax

  return { isBlank: basic && stddevOk, analysis }
}


