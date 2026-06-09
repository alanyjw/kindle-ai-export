import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import JSZip from 'jszip'

// A map of zip-relative path → file contents. `mimetype` is written first and
// STORED (uncompressed) per the EPUB OCF spec regardless of key order.
export type EpubFiles = Record<string, string | Buffer>

// Builds a valid .epub zip from in-memory sources and writes it to a temp file,
// returning the absolute path (epub2.createAsync needs a path). Deterministic:
// JSZip emits entries in insertion order, so mimetype lands first.
export async function buildFixtureEpub(
  files: EpubFiles,
  name = 'fixture'
): Promise<string> {
  const zip = new JSZip()

  // mimetype MUST be the first entry and STORED, not deflated.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  for (const [p, content] of Object.entries(files)) {
    if (p === 'mimetype') continue
    zip.file(p, content)
  }

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip'
  })

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-fixture-'))
  const outPath = path.join(dir, `${name}.epub`)
  await fs.writeFile(outPath, buf)
  return outPath
}

// Standard OCF container pointing at a single OPF.
export function containerXml(opfPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
}
