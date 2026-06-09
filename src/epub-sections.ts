import { type HTMLElement, type Node, parse } from 'node-html-parser'

import type { EpubNavEntry, EpubSpineItem } from './epub'
import { firstHeading, headingText, isPromotableHeading } from './epub-markdown'

// A derived reading-order unit: one chunk + one TOC entry each.
export interface Section {
  key: string // becomes the "epub:<key>" screenshot key
  title: string // already resolved (Section {n} filled in)
  html: string // the section's XHTML fragment
  stripLeadingHeading: boolean
  spineHref: string // base for resolving the section's image hrefs
}

function basename(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
}

// Tolerant path match between a nav fileHref and a spine href (they come from
// epub2 in the same coordinate system, but fall back to basename to be safe).
function samePath(a: string, b: string): boolean {
  return a === b || basename(a) === basename(b)
}

function bodyOf(root: HTMLElement): HTMLElement {
  return root.querySelector('body') ?? root
}

function serializeNodes(nodes: Node[]): string {
  return nodes.map((n) => n.toString()).join('')
}

function hasSubstantiveText(html: string): boolean {
  return parse(html).text.replaceAll(/\s+/g, '').length > 0
}

// The top-level child index (within body.childNodes) at which a fragment's
// content begins: the anchored element climbed to its ancestor that is a direct
// child of body. Missing/degenerate anchors snap to top-of-file (index 0).
function splitIndexForFragment(
  body: HTMLElement,
  childNodes: Node[],
  fragment: string
): number {
  const el = body.querySelector(`[id="${fragment}"]`)
  if (!el) return 0
  let cur: HTMLElement = el
  while (cur.parentNode && cur.parentNode !== body) {
    cur = cur.parentNode as HTMLElement
  }
  if (cur.parentNode !== body) return 0
  const idx = childNodes.indexOf(cur)
  return idx >= 0 ? idx : 0
}

// Picks a section title from an in-text leading heading (preferred, when it
// passes the junk-guard) else a nav title; returns null to defer to "Section n".
function titleFor(
  fragmentHtml: string,
  navTitle: string | undefined
): { title: string | null; stripLeadingHeading: boolean } {
  const heading = firstHeading(parse(fragmentHtml))
  if (heading) {
    const text = headingText(heading)
    if (isPromotableHeading(text)) {
      return { title: text, stripLeadingHeading: true }
    }
  }
  const nav = navTitle?.trim()
  return { title: nav || null, stripLeadingHeading: false }
}

// Derives ordered sections from the spine + nav. Chunks by nav section with
// anchor-aware splitting so single-file EPUBs (one XHTML, many nav anchors) and
// multi-file EPUBs both produce one section per chapter.
export async function deriveSections(
  spine: EpubSpineItem[],
  nav: EpubNavEntry[],
  getHtml: (id: string) => Promise<string>
): Promise<Section[]> {
  const sections: Array<Omit<Section, 'title'> & { title: string | null }> = []

  for (const S of spine) {
    const html = await getHtml(S.id)
    const body = bodyOf(parse(html))
    const childNodes = body.childNodes

    const hits = nav
      .filter((e) => samePath(e.fileHref, S.href))
      .map((e) => ({
        entry: e,
        splitIndex: e.fragment
          ? splitIndexForFragment(body, childNodes, e.fragment)
          : 0
      }))
      .sort(
        (a, b) => a.splitIndex - b.splitIndex || a.entry.order - b.entry.order
      )

    // Dedupe hits that resolve to the same split point (keep the first title).
    const distinct: typeof hits = []
    const seen = new Set<number>()
    for (const h of hits) {
      if (seen.has(h.splitIndex)) continue
      seen.add(h.splitIndex)
      distinct.push(h)
    }

    if (distinct.length === 0) {
      // Orphan whole-file section (no cross-file merge — avoids misattribution).
      const wholeHtml = serializeNodes(childNodes)
      const { title, stripLeadingHeading } = titleFor(wholeHtml, undefined)
      sections.push({
        key: S.id,
        title,
        html: wholeHtml,
        stripLeadingHeading,
        spineHref: S.href
      })
      continue
    }

    const firstBoundary = distinct[0]!.splitIndex
    const leadNodes =
      firstBoundary > 0 ? childNodes.slice(0, firstBoundary) : []

    const hitSections: Array<
      Omit<Section, 'title'> & { title: string | null }
    > = distinct.map((h, i) => {
      const start = h.splitIndex
      const end =
        i + 1 < distinct.length
          ? distinct[i + 1]!.splitIndex
          : childNodes.length
      const segHtml = serializeNodes(childNodes.slice(start, end))
      const { title, stripLeadingHeading } = titleFor(segHtml, h.entry.title)
      const key = h.entry.fragment ? `${S.id}#${h.entry.fragment}` : S.id
      return {
        key,
        title,
        html: segHtml,
        stripLeadingHeading,
        spineHref: S.href
      }
    })

    // Lead segment (content before the first anchor) stays within S.
    if (leadNodes.length) {
      const leadHtml = serializeNodes(leadNodes)
      const leadHeading = firstHeading(parse(leadHtml))
      if (leadHeading && isPromotableHeading(headingText(leadHeading))) {
        sections.push({
          key: `${S.id}#__lead`,
          title: headingText(leadHeading),
          html: leadHtml,
          stripLeadingHeading: true,
          spineHref: S.href
        })
      } else if (hasSubstantiveText(leadHtml)) {
        hitSections[0]!.html = leadHtml + hitSections[0]!.html
      }
    }

    sections.push(...hitSections)
  }

  // Fill deferred titles with their final 1-based position.
  return sections.map((s, i) => ({
    ...s,
    title: s.title ?? `Section ${i + 1}`
  }))
}
