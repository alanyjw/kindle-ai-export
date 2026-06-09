import type { EpubFiles } from '../helpers/build-fixture-epub'
import { containerXml } from '../helpers/build-fixture-epub'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

// Fixture A: single XHTML "book.xhtml" with 3 chapters delineated by #frag nav
// anchors (NCX), an orphan front-matter file (no nav entry), one image, an
// intra-EPUB footnote link, an external link, a mid-element span anchor (#c2),
// and a text-rich final chapter. Spine: front, book, notes.
export function fixtureA(): EpubFiles {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:fixture-a</dc:identifier>
    <dc:title>Fixture A Book</dc:title>
    <dc:creator>Ada Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>
    <item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="front"/>
    <itemref idref="book"/>
    <itemref idref="notes"/>
  </spine>
</package>`

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="book.xhtml#c1"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="book.xhtml#c2"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>Chapter Three</text></navLabel><content src="book.xhtml#c3"/></navPoint>
  </navMap>
</ncx>`

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="book.xhtml#c1">Chapter One</a></li>
<li><a href="book.xhtml#c2">Chapter Two</a></li>
<li><a href="book.xhtml#c3">Chapter Three</a></li>
</ol></nav></body></html>`

  const front = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h1>Front Matter</h1><p>Copyright and dedication.</p>
</body></html>`

  // #c2's anchor is on a <span> inside the heading — exercises block promotion.
  const book = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h1 id="c1">Chapter One</h1>
<p>One body with <img src="images/p.png" alt="pic"/> and a <a href="notes.xhtml#fn1">note</a>.</p>
<h2>A subsection</h2>
<p>Subsection text.</p>
<h1><span id="c2">Chapter Two</span></h1>
<p>Two body content.</p>
<h1 id="c3">Chapter Three</h1>
<p>Three body, the final and text-rich section with a <a href="https://example.com">site</a>.</p>
</body></html>`

  const notes = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h2 id="fn1">Notes</h2><p>Footnote one text.</p>
</body></html>`

  return {
    'META-INF/container.xml': containerXml('content.opf'),
    'content.opf': opf,
    'toc.ncx': ncx,
    'nav.xhtml': nav,
    'front.xhtml': front,
    'book.xhtml': book,
    'notes.xhtml': notes,
    'images/p.png': PNG
  }
}

// Fixture B: nav-only EPUB3 — no NCX, no `<spine toc>`. Two spine files, both
// listed in nav.xhtml. Exercises the manual nav.xhtml parse path.
export function fixtureB(): EpubFiles {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:fixture-b</dc:identifier>
    <dc:title>Fixture B Book</dc:title>
    <dc:creator>Bee Writer</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="b1" href="b1.xhtml" media-type="application/xhtml+xml"/>
    <item id="b2" href="b2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="b1"/>
    <itemref idref="b2"/>
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="b1.xhtml">Part One</a></li>
<li><a href="b2.xhtml">Part Two</a></li>
</ol></nav></body></html>`

  const b1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h1>Part One</h1><p>First part body content with enough text.</p>
</body></html>`

  const b2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h1>Part Two</h1><p>Second part body content with enough text.</p>
</body></html>`

  return {
    'META-INF/container.xml': containerXml('content.opf'),
    'content.opf': opf,
    'nav.xhtml': nav,
    'b1.xhtml': b1,
    'b2.xhtml': b2
  }
}
