import type { OpenAIClient } from 'openai-fetch'

import type { TitlePageExtractor, TitlePageMeta } from './title-page-meta'

const TITLE_PAGE_SYSTEM_PROMPT = `You are given the first few page images of a book (typically the cover, title page, and copyright page). Identify the book's exact title and author(s) as printed.

Respond with ONLY a JSON object, no prose, in this exact shape:
{"title": string | null, "authorList": string[]}

Rules:
- "title": the main book title exactly as printed (include a subtitle only if it is clearly part of the title). Use null if you cannot find it.
- "authorList": the author name(s) in natural reading order ("First Last"). Empty array if none is visible.
- Do not guess from general knowledge; read only what is shown in the images.`

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

// Pull the first JSON object out of a model response (handles ```json fences).
function parseTitlePageJson(raw: string): TitlePageMeta | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as {
      title?: unknown
      authorList?: unknown
    }
    const title =
      typeof obj.title === 'string' && obj.title.trim()
        ? obj.title.trim()
        : undefined
    const authorList = Array.isArray(obj.authorList)
      ? obj.authorList.filter((a): a is string => typeof a === 'string')
      : []
    return { title, authorList }
  } catch {
    return null
  }
}

// A TitlePageExtractor backed by OpenAI vision (gpt-4o), mirroring the OCR call
// used in transcribe-book-content.ts. Kept thin and free of orchestration so
// the testable logic lives in title-page-meta.ts.
export function createOpenAITitlePageExtractor(
  openai: OpenAIClient,
  model = 'gpt-4o'
): TitlePageExtractor {
  return {
    async extract(images: Buffer[]): Promise<TitlePageMeta | null> {
      if (images.length === 0) return null

      const res = await openai.createChatCompletion({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: TITLE_PAGE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: images.map((png) => ({
              type: 'image_url',
              image_url: { url: toDataUrl(png) }
            })) as any
          }
        ]
      })

      const raw = res.choices[0]?.message.content
      if (!raw) return null
      return parseTitlePageJson(raw)
    }
  }
}

export { parseTitlePageJson }
