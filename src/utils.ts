import { createWriteStream, type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import hashObjectImpl from 'hash-object'
import timeFormat from 'hh-mm-ss'

export {
  assert,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse
} from 'kindle-api-ky'

const numerals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

export function deromanize(romanNumeral: string): number {
  const roman = romanNumeral.toUpperCase().split('')
  let num = 0
  let val = 0

  while (roman.length) {
    val = numerals[roman.shift()! as keyof typeof numerals]
    num += val * (val < numerals[roman[0] as keyof typeof numerals] ? -1 : 1)
  }

  return num
}

export async function fileExists(
  filePath: string,
  mode: number = fs.constants.F_OK | fs.constants.R_OK
): Promise<boolean> {
  try {
    await fs.access(filePath, mode)
    return true
  } catch {
    return false
  }
}

export function hashObject(obj: Record<string, any>): string {
  return hashObjectImpl(obj, {
    algorithm: 'sha1',
    encoding: 'hex'
  })
}

export function sanitizeDirname(name: string): string {
  // Remove characters not allowed in file/folder names and collapse spaces
  return name
    .replaceAll(/["*/:<>?\\|]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 128)
}

const SCREENSHOT_FILENAME_RE = /(?:^|\/)(\d+)-(\d+)\.png$/

// Parses page screenshot filenames of the form "<index>-<page>.png", optionally
// prefixed by directory segments. Returns null if the filename doesn't match.
//
// Correctness note: an earlier implementation used `/\d*-?(\d+)-(\d+)\.png$/`,
// which the regex engine expanded greedily and then backtracked, leaving only
// the last digit of the index in the first capture group (e.g. `281-221.png`
// → index=1, page=221). That silently corrupted content.json indices. Do not
// reintroduce optional prefixes here; if a prefix ever appears in the path, it
// will be on a directory boundary that the `(?:^|\/)` anchor already handles.
export function parseScreenshotFilename(
  screenshot: string
): { index: number; page: number } | null {
  const m = screenshot.match(SCREENSHOT_FILENAME_RE)
  if (!m?.[1] || !m[2]) return null
  const index = Number.parseInt(m[1], 10)
  const page = Number.parseInt(m[2], 10)
  if (!Number.isFinite(index) || !Number.isFinite(page)) return null
  return { index, page }
}

export async function resolveOutDir(asin: string): Promise<string> {
  const baseOutDir = 'out'
  try {
    const entries = (await fs.readdir(baseOutDir, {
      withFileTypes: true
    } as any)) as unknown as Dirent[]

    // Look for directories that start with ASIN (supports both old and new formats)
    // Old format: "ASIN"
    // New format: "ASIN-Book Title"
    const matches = entries
      .filter(
        (e) =>
          e.isDirectory() && e.name.toLowerCase().startsWith(asin.toLowerCase())
      )
      // Prefer titled directories (longer names) when both exist
      .sort((a, b) => b.name.length - a.name.length)

    if (matches.length > 0) {
      return path.join(baseOutDir, matches[0]!.name)
    }
  } catch {}

  return path.join(baseOutDir, asin)
}

// Tees `console.log/warn/error` to a file while preserving terminal output.
// Uses a WriteStream so appended lines stay in call order (unlike fire-and-
// forget `fs.appendFile`, which can reorder under load).
export async function setupTeeLogger(logPath: string) {
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const stream = createWriteStream(logPath, { flags: 'a' })

  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)

  const append = (message: string) => {
    stream.write(message + '\n')
  }
  const formatArgs = (args: any[]) =>
    args
      .map((a) =>
        typeof a === 'string'
          ? a
          : (() => {
              try {
                return JSON.stringify(a)
              } catch {
                return String(a)
              }
            })()
      )
      .join(' ')

  console.log = (...args: any[]) => {
    origLog(...args)
    append(formatArgs(args))
  }
  console.warn = (...args: any[]) => {
    origWarn(...args)
    append(formatArgs(args))
  }
  console.error = (...args: any[]) => {
    origError(...args)
    append(formatArgs(args))
  }

  // Flush on natural process exit so short scripts don't drop the tail.
  process.on('beforeExit', () => stream.end())

  return { logPath, append }
}

// Create a timestamped log file in the given outDir and tee console output to
// both terminal and file. Returns the path of the log file and a function to
// append custom messages.
export async function setupTimestampedLogger(outDir: string) {
  const now = new Date()
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
  const logPath = path.join(outDir, 'logs', `${timestamp}.log`)
  return setupTeeLogger(logPath)
}

// A simple terminal progress bar helper
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function createProgressBar(total: number, width = 30) {
  let completed = 0

  function render() {
    const safeTotal = Math.max(0, total)
    let ratio = safeTotal > 0 ? completed / safeTotal : 1
    ratio = clamp(ratio, 0, 1)
    const filled = Math.round(width * ratio)
    const bar = `${'='.repeat(Math.max(0, filled - 1))}${filled > 0 ? '>' : ''}${'.'.repeat(Math.max(0, width - filled))}`
    const pct = String(Math.round(ratio * 100)).padStart(3, ' ') + '%'
    if (process.stdout.isTTY) {
      process.stdout.write(`\r[${bar}] ${pct} (${completed}/${safeTotal})`)
    }
  }

  function tick(amount = 1) {
    completed += amount
    render()
  }

  function set(value: number) {
    completed = value
    render()
  }

  // initial render
  render()

  return { tick, set, done: progressBarNewline }
}

export function progressBarNewline() {
  if (process.stdout.isTTY) {
    process.stdout.write('\n')
  }
}

export type FfmpegProgressEvent = {
  frames: number
  currentFps: number
  currentKbps: number
  targetSize: number
  timemark: string
  percent?: number | undefined
}

export function ffmpegOnProgress(
  onProgress: (progress: number, event: FfmpegProgressEvent) => void,
  durationMs: number
) {
  return (event: FfmpegProgressEvent) => {
    let progress = 0

    try {
      const timestamp = timeFormat.toMs(event.timemark)
      progress = timestamp / durationMs
    } catch {}

    if (
      Number.isNaN(progress) &&
      event.percent !== undefined &&
      !Number.isNaN(event.percent)
    ) {
      progress = event.percent / 100
    }

    if (!Number.isNaN(progress)) {
      progress = Math.max(0, Math.min(1, progress))
      onProgress(progress, event)
    }
  }
}
