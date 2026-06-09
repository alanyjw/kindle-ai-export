import { NodeHtmlMarkdown } from 'node-html-markdown'
import { type HTMLElement, parse } from 'node-html-parser'

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6'
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

// A link is "external" (kept as a Markdown link) when it carries one of a small
// allow-list of schemes. Everything else — bare #fragments, relative paths,
// epub: — is an intra-EPUB link that would dangle in the combined output, so it
// is unwrapped to its children.
export function isExternalLink(href: string): boolean {
  const m = href.match(/^([a-z][a-z0-9+.-]*):/i)
  return m ? EXTERNAL_SCHEMES.has(m[1]!.toLowerCase()) : false
}

// Normalized text of a heading element: tags/images stripped, whitespace
// collapsed. Used both for the junk-guard and for title matching.
export function headingText(el: HTMLElement): string {
  return el.text.replaceAll(/\s+/g, ' ').trim()
}

// A heading is promotable to a section title only if it has real textual
// substance — rejects drop-caps ("P"), image-only/empty headings, and
// punctuation-only headings, while accepting numeric titles ("1984").
export function isPromotableHeading(text: string): boolean {
  return text.length >= 2 && /[\p{L}\p{N}]/u.test(text)
}

// Returns the first heading element in document order, or null.
export function firstHeading(root: HTMLElement): HTMLElement | null {
  return root.querySelector(HEADING_SELECTOR)
}

export interface SectionHtmlToMarkdownOptions {
  // When true, the first heading (already chosen as the section title) is
  // stripped so the exporter-injected `## title` isn't duplicated in the body.
  stripLeadingHeading: boolean
  // Maps an original <img src> to a rewritten path ("images/<name>"), or null to
  // drop the image. NOT called for data: URIs (those pass through untouched).
  resolveImage: (originalSrc: string) => string | null
}

// Converts a section's XHTML fragment to Markdown: strips the promoted heading,
// demotes remaining headings to nest under the exporter's h2, unwraps
// intra-EPUB links, and rewrites/drops images.
export function sectionHtmlToMarkdown(
  html: string,
  opts: SectionHtmlToMarkdownOptions
): string {
  const root = parse(html)
  const body = root.querySelector('body') ?? root

  if (opts.stripLeadingHeading) {
    const h = firstHeading(body)
    h?.parentNode?.removeChild(h)
  }

  // Links: unwrap intra-EPUB anchors (keep children, incl. images), leave
  // external links for nhm to render.
  for (const a of body.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (!isExternalLink(href)) {
      a.replaceWith(...a.childNodes)
    }
  }

  // Images: rewrite src to the extracted path, drop on null, pass through data:.
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (src.startsWith('data:')) continue
    const mapped = opts.resolveImage(src)
    if (mapped == null) {
      img.parentNode?.removeChild(img)
    } else {
      img.setAttribute('src', mapped)
    }
  }

  // Demote remaining headings so the shallowest becomes h3 (under the
  // exporter's injected h2), clamped at h6.
  const headings = body.querySelectorAll(HEADING_SELECTOR)
  const levels = headings.map((h) => Number(h.tagName.charAt(1)))
  const minLevel = levels.length ? Math.min(...levels) : 0
  const offset = minLevel ? 3 - minLevel : 0

  const md = NodeHtmlMarkdown.translate(
    body.innerHTML,
    { keepDataImages: true },
    {
      'h1,h2,h3,h4,h5,h6': ({ node }) => {
        const level = Number(node.tagName.charAt(1))
        const shifted = Math.min(6, Math.max(1, level + offset))
        return { prefix: '#'.repeat(shifted) + ' ' }
      }
    }
  )

  return md.trim()
}
