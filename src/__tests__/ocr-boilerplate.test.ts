import { describe, expect, it } from 'vitest'

import { stripOcrBoilerplate } from '../ocr-boilerplate'

describe('stripOcrBoilerplate', () => {
  it('drops a vision-model refusal line', () => {
    const text = [
      'Real transcribed text.',
      "I'm sorry, I can't help with identifying people in this image.",
      'More real text.'
    ].join('\n')

    expect(stripOcrBoilerplate(text)).toBe(
      'Real transcribed text.\nMore real text.'
    )
  })

  it('drops the other known refusal phrasings', () => {
    const refusals = [
      "I'm sorry, I can't assist with the uploaded image.",
      "I'm unable to help with analyzing this image.",
      "I can't identify people in images.",
      'Could you please try again with a clearer photo?',
      'I cannot provide information about people in images.'
    ]

    for (const refusal of refusals) {
      expect(stripOcrBoilerplate(`Before.\n${refusal}\nAfter.`)).toBe(
        'Before.\nAfter.'
      )
    }
  })

  it('keeps a long prose line that merely contains the trigger words', () => {
    // Regression: PDF text extraction emits one line per page, so an
    // unbounded `.*` between "I'm sorry" and "image" could span a whole page
    // of real prose and delete it. A refusal is a short line, never 2,000
    // characters of narrative.
    const prose =
      'She finally said “I’m sorry.” Explain what you will do differently going forward, ' +
      'and then follow through on your commitment to the team. '.repeat(20) +
      'The image on the wall said otherwise.'

    expect(prose.length).toBeGreaterThan(300)
    expect(stripOcrBoilerplate(prose)).toBe(prose)
  })

  it('keeps a long line even when it opens with a refusal-like clause', () => {
    const prose =
      "I can't do that unless I'm completely honest with you. " +
      'A big part of management is developing stronger skills in your reports. '.repeat(
        20
      ) +
      'That helps whether or not you have an image of success.'

    expect(stripOcrBoilerplate(prose)).toBe(prose)
  })

  it('leaves ordinary text untouched', () => {
    const text = 'Chapter 1\n\nOnce upon a time.'
    expect(stripOcrBoilerplate(text)).toBe(text)
  })

  it('collapses runs of blank lines and trims the result', () => {
    expect(stripOcrBoilerplate('\n\nAlpha.\n\n\n\nBeta.\n\n')).toBe(
      'Alpha.\n\nBeta.'
    )
  })

  it('handles empty input', () => {
    expect(stripOcrBoilerplate('')).toBe('')
  })
})
