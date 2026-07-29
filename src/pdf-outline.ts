import type { TocItem } from './types'

/**
 * A node in a PDF's embedded outline (a.k.a. bookmarks), with its destination
 * already resolved to a 1-based page number by the caller.
 *
 * `page` is optional because a destination can fail to resolve (a named
 * destination the document never defines, an action rather than a dest, a
 * corrupt reference). Such a node still legitimately carries children.
 */
export interface PdfOutlineNode {
  title: string
  page?: number
  items?: PdfOutlineNode[]
}

export interface FlattenPdfOutlineOptions {
  /** Page count of the PDF; recorded on every item as `total`. */
  totalPages: number
  /**
   * Deepest nesting level to record. Levels beyond this are clamped rather
   * than dropped, so a deeply nested outline still contributes every heading.
   * Defaults to 1 (parts + chapters), which is as deep as the markdown
   * exporter meaningfully distinguishes.
   */
  maxLevel?: number
}

const DEFAULT_MAX_LEVEL = 1

/**
 * Convert a PDF's embedded outline into the flat `TocItem[]` the exporters
 * consume, tagging each entry with its nesting `level` so headings can be
 * rendered at the right depth.
 *
 * Entries whose destination didn't resolve to a valid page are dropped, but
 * their children are kept — a part with an unresolvable dest shouldn't take
 * its chapters down with it.
 */
export function flattenPdfOutline(
  nodes: readonly PdfOutlineNode[] | undefined | null,
  opts: FlattenPdfOutlineOptions
): TocItem[] {
  const { totalPages } = opts
  const maxLevel = opts.maxLevel ?? DEFAULT_MAX_LEVEL

  const items: TocItem[] = []

  const walk = (
    list: readonly PdfOutlineNode[] | undefined | null,
    depth: number
  ): void => {
    for (const node of list ?? []) {
      const title = node.title?.trim().replaceAll(/\s+/g, ' ') ?? ''
      const page = node.page

      const hasValidPage =
        typeof page === 'number' &&
        Number.isInteger(page) &&
        page >= 1 &&
        page <= totalPages

      if (title && hasValidPage) {
        items.push({
          title,
          page,
          level: Math.min(depth, maxLevel),
          total: totalPages
        })
      }

      walk(node.items, depth + 1)
    }
  }

  walk(nodes, 0)

  // Outline order is usually already page order, but malformed documents do
  // exist. Array#sort is stable, so entries sharing a page keep outline order
  // (a part stays ahead of the chapter that starts on the same page).
  return items.sort((a, b) => a.page! - b.page!)
}
