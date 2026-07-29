import { describe, expect, it } from 'vitest'

import { cleanSectionOpening } from '../pdf-drop-cap'

describe('cleanSectionOpening', () => {
  it('strips the echoed heading and reattaches the drop cap to its word', () => {
    // PDF text extraction hoists the drop cap out in front of the heading, so
    // the paragraph's first word arrives split in two: "H" + "ow has ...".
    expect(
      cleanSectionOpening(
        'H Example ow has failure shaped you? As a department head, I tried.',
        '1 | Example'
      )
    ).toBe('How has failure shaped you? As a department head, I tried.')
  })

  it('strips the echoed heading when there is no drop cap', () => {
    expect(
      cleanSectionOpening(
        'ACKNOWLEDGMENTS I would like to acknowledge the team.',
        'ACKNOWLEDGMENTS'
      )
    ).toBe('I would like to acknowledge the team.')
  })

  it('keeps a standalone "I" separate when the next token is a real word', () => {
    // The drop cap here IS the word "I" — merging would produce "Ihad".
    expect(
      cleanSectionOpening(
        'I FOREWORD had the opportunity to visit.',
        'FOREWORD'
      )
    ).toBe('I had the opportunity to visit.')
  })

  it('attaches "I" when the next token is only a word fragment', () => {
    expect(
      cleanSectionOpening(
        'I Example s your organization spending more energy avoiding errors?',
        '7 | Example'
      )
    ).toBe('Is your organization spending more energy avoiding errors?')
  })

  it('attaches "A" when the next token is only a word fragment', () => {
    expect(
      cleanSectionOpening(
        'A PART IV ENDINGS s more authority is pushed down, clarity matters.',
        'PART IV | ENDINGS'
      )
    ).toBe('As more authority is pushed down, clarity matters.')
  })

  it('keeps "A" separate when the next token is a real word', () => {
    expect(
      cleanSectionOpening(
        'A GLOSSARY definition can be hard to write.',
        'GLOSSARY'
      )
    ).toBe('A definition can be hard to write.')
  })

  it('matches loosely across the "N | " numbering prefix and pipes', () => {
    // The body text renders "PART I STARTING OVER" without the pipe the
    // outline entry carries, and omits the chapter number entirely.
    expect(
      cleanSectionOpening(
        'O PART I BEGINNINGS ur greatest struggle is within ourselves.',
        'PART I | BEGINNINGS'
      )
    ).toBe('Our greatest struggle is within ourselves.')
  })

  it('skips punctuation left over from a quoted heading', () => {
    // The heading ends in `!”`, which extraction leaves stranded between the
    // echo and the drop-capped word's tail.
    expect(
      cleanSectionOpening(
        'D “Welcome Along !” on’t like something about the culture?',
        '9 | “Welcome Along!”'
      )
    ).toBe('Don’t like something about the culture?')
  })

  it('skips spaced-out ellipsis punctuation from a quoted heading', () => {
    expect(
      cleanSectionOpening(
        'H “I Intend To . . .” ow proactive are your managers?',
        '11 | “I Intend To . . .”'
      )
    ).toBe('How proactive are your managers?')
  })

  it('leaves text untouched when the heading is not echoed', () => {
    const text = 'PORTFOLIO / PENGUIN Published by the Publishing Group.'
    expect(cleanSectionOpening(text, 'COPYRIGHT')).toBe(text)
  })

  it('leaves text untouched when the echo only partially matches', () => {
    const text = 'PRAISE FOR Example Book “A fine model of leadership.”'
    expect(cleanSectionOpening(text, 'PRAISE FOR THE BOOK')).toBe(text)
  })

  it('handles a blank-page marker and empty input safely', () => {
    expect(cleanSectionOpening('[BLANK_PAGE]', 'DEDICATION')).toBe(
      '[BLANK_PAGE]'
    )
    expect(cleanSectionOpening('', 'DEDICATION')).toBe('')
    expect(cleanSectionOpening('Some text.', '')).toBe('Some text.')
  })

  it('does not merge when the echo is followed by a capitalised word', () => {
    // No drop cap to reattach — the body simply continues after the heading.
    expect(
      cleanSectionOpening(
        'CAST OF CHARACTERS CAPTAIN SMITH Commanding Officer.',
        'CAST OF CHARACTERS'
      )
    ).toBe('CAPTAIN SMITH Commanding Officer.')
  })
})
