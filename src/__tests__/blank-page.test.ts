import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'

import { isBlankPageFromPng } from '../image'

describe('isBlankPageFromPng', () => {
  it('treats a fully white image as blank', async () => {
    const canvas = createCanvas(600, 800)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const png = canvas.toBuffer('image/png')
    const res = await isBlankPageFromPng(png, {
      whiteRatioThreshold: 0.95,
      whiteLuma: 245,
      blackLuma: 30,
      darkRatioMax: 0.002,
      cropPct: 0,
      sampleStep: 4,
      maxDimension: 512
    })

    expect(res.isBlank).toBe(true)
    expect(res.analysis.whiteRatio).toBeGreaterThan(0.98)
  })

  it('does not treat a page with a visible dark block as blank', async () => {
    const canvas = createCanvas(600, 800)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Add enough "ink" to exceed darkRatioMax in the sampled image.
    ctx.fillStyle = '#000000'
    ctx.fillRect(50, 50, 160, 160)

    const png = canvas.toBuffer('image/png')
    const res = await isBlankPageFromPng(png, {
      whiteRatioThreshold: 0.95,
      whiteLuma: 245,
      blackLuma: 30,
      darkRatioMax: 0.002,
      cropPct: 0,
      sampleStep: 4,
      maxDimension: 512
    })

    expect(res.isBlank).toBe(false)
    expect(res.analysis.darkRatio).toBeGreaterThan(0.002)
  })
})
