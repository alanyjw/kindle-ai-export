/**
 * Removal of vision-model refusal text that leaks into transcriptions.
 *
 * When OCR hits a page the model won't describe (photos of people, mostly) it
 * emits an apology instead of a transcription. Those lines are noise in the
 * exported book.
 */

/**
 * Longest line we'll consider a refusal.
 *
 * This bound is load-bearing, not a nicety. `extractPdfPageText` joins a whole
 * PDF page into a *single line*, so without it the unbounded gaps in the
 * matchers below can bridge thousands of characters of ordinary prose — a page
 * saying `“I’m sorry.”` early on and mentioning an `image` 2,000 characters
 * later would be deleted in full. Real refusals are a sentence or two.
 */
const MAX_REFUSAL_LINE_LENGTH = 300

/**
 * Gaps are bounded for the same reason. Every phrase these match is a single
 * short sentence, so 120 characters is generous.
 */
const REFUSAL_MATCHERS: readonly RegExp[] = [
  /i['’]m sorry.{0,120}(image|uploaded|visible)/i,
  /\bi (can|can't|cannot)\b.{0,120}\b(help|assist)\b.{0,120}\b(image|uploaded)\b/i,
  /\bi['’]m unable to\b.{0,120}\b(help|view|analyze)\b.{0,120}\b(image|uploaded)\b/i,
  /\bi can'?t identify\b.{0,120}\bpeople\b.{0,120}\bimages?\b/i,
  /could you please (try again|provide|describe)/i,
  /i (can|can't|cannot) (identify|provide information about).{0,120}people in images/i
]

/**
 * Drop refusal lines from transcribed text, collapsing the blank space they
 * leave behind. Lines longer than `MAX_REFUSAL_LINE_LENGTH` are always kept —
 * they're page-sized prose, not an apology.
 */
export function stripOcrBoilerplate(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n')

  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return true
    if (trimmed.length > MAX_REFUSAL_LINE_LENGTH) return true
    return !REFUSAL_MATCHERS.some((re) => re.test(trimmed))
  })

  return kept
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}
