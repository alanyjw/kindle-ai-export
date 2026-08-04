export interface BookFlags {
  pdf: boolean
  audio: boolean
  force: boolean
}

export const BOOK_USAGE = `Usage: pnpm book <input> [flags]

  <input>
    book.pdf     transcribe from PDF, then export
    book.epub    transcribe from EPUB, then export
    B0819W19WD   Kindle ASIN — extract, transcribe, then export
    out/<dir>    skip extract + transcribe; re-export from existing content.json

  flags
    --pdf        also export book.pdf
    --audio      also export the audiobook
    --all        equivalent to --pdf --audio
    --force      re-extract and regenerate audio even if already done;
                 does NOT re-transcribe — delete content.json for that`

const NO_FLAGS: BookFlags = { pdf: false, audio: false, force: false }

// Parses everything after the <input> argument. Unknown tokens are a hard
// error rather than being ignored, so a typo like `--pfd` fails loudly instead
// of silently skipping the PDF export.
export function parseBookFlags(argv: readonly string[]): BookFlags {
  return argv.reduce<BookFlags>((flags, arg) => {
    switch (arg) {
      case '--pdf':
        return { ...flags, pdf: true }
      case '--audio':
        return { ...flags, audio: true }
      case '--all':
        return { ...flags, pdf: true, audio: true }
      case '--force':
        return { ...flags, force: true }
      default:
        throw new Error(`Unknown flag: ${arg}\n\n${BOOK_USAGE}`)
    }
  }, NO_FLAGS)
}
