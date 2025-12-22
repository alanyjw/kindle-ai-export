import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { ContentChunk } from './types'
import { assert, sanitizeDirname } from './utils'

function stripOcrBoilerplate(text: string): string {
  const boilerplateLineMatchers: RegExp[] = [
    /i['’]m sorry.*(image|uploaded|visible)/i,
    /\bi (can|can't|cannot)\b.*\b(help|assist)\b.*\b(image|uploaded)\b/i,
    /\bi['’]m unable to\b.*\b(help|view|analyze)\b.*\b(image|uploaded)\b/i,
    /\bi can'?t identify\b.*\bpeople\b.*\bimages?\b/i,
    /could you please (try again|provide|describe)/i,
    /i (can|can't|cannot) (identify|provide information about).*people in images/i
  ]

  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const kept = lines.filter((line) => {
    const t = line.trim()
    if (!t) return true
    return !boilerplateLineMatchers.some((re) => re.test(t))
  })

  return kept
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

function formatPdfTextToMarkdown(body: string): string {
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  const out: string[] = []

  const pushBlank = () => {
    if (out.length === 0) return
    if (out.at(-1) !== '') out.push('')
  }

  const splitHeadingAndRest = (
    line: string,
    kind: 'part' | 'chapter'
  ): { heading: string; rest: string } => {
    const trimmed = line.trim()
    const prefixLen =
      kind === 'part'
        ? (trimmed.match(/^part\b/i)?.[0].length ?? 0)
        : (trimmed.match(/^chapter\s+\d+\b/i)?.[0].length ?? 0)

    const after = trimmed.slice(prefixLen)
    const m = after.match(/\s+[A-Z][a-z]/)
    if (m && m.index !== undefined) {
      const pos = prefixLen + m.index
      return {
        heading: trimmed.slice(0, pos).trim(),
        rest: trimmed.slice(pos).trim()
      }
    }

    return { heading: trimmed, rest: '' }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      out.push('')
      continue
    }

    const cleanedLine = stripOcrBoilerplate(line)
    if (!cleanedLine) continue

    if (/^part\b/i.test(cleanedLine)) {
      const { heading, rest } = splitHeadingAndRest(cleanedLine, 'part')
      pushBlank()
      out.push(`## ${heading}`)
      out.push('')
      if (rest) out.push(rest)
      continue
    }

    if (/^chapter\s+\d+\b/i.test(cleanedLine)) {
      const { heading, rest } = splitHeadingAndRest(cleanedLine, 'chapter')
      pushBlank()
      out.push(`## ${heading}`)
      out.push('')
      if (rest) out.push(rest)
      continue
    }

    out.push(cleanedLine)
  }

  return out
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

async function main() {
  const outDirArg = process.argv[2]
  const outDir = outDirArg
    ? path.resolve(outDirArg)
    : path.resolve('out/Peopleware')
  const title = sanitizeDirname(path.basename(outDir))

  const contentPath = path.join(outDir, 'content.json')
  const mdPath = path.join(outDir, `${title}.md`)
  assert(
    await fs
      .stat(contentPath)
      .then(() => true)
      .catch(() => false),
    `missing ${contentPath}`
  )
  assert(
    await fs
      .stat(mdPath)
      .then(() => true)
      .catch(() => false),
    `missing ${mdPath}`
  )

  const raw = await fs.readFile(contentPath, 'utf8')
  const content = JSON.parse(raw) as ContentChunk[]
  assert(
    Array.isArray(content) && content.length > 0,
    'invalid or empty content.json'
  )

  const cleaned: ContentChunk[] = content.map((c) => ({
    ...c,
    text: stripOcrBoilerplate(c.text)
  }))

  const cleanedPath = path.join(outDir, 'content.cleaned.json')
  await fs.writeFile(cleanedPath, JSON.stringify(cleaned, null, 2))

  const sorted = [...cleaned].sort(
    (a, b) => a.page - b.page || a.index - b.index
  )
  const body = sorted
    .map((c) => c.text)
    .filter(Boolean)
    .join('\n\n')
  const formattedBody = formatPdfTextToMarkdown(body)
  const cleanedMdPath = path.join(outDir, `${title}.cleaned.md`)
  const output = `# ${title}\n\n${formattedBody}\n`
  await fs.writeFile(cleanedMdPath, output)

  console.log('migration complete', {
    outDir,
    cleanedPath,
    cleanedMdPath,
    pages: cleaned.length
  })
}

await main()
