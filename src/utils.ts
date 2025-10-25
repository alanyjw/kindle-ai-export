import type { Dirent } from 'node:fs'
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

export async function resolveOutDir(asin: string): Promise<string> {
  const baseOutDir = 'out'
  try {
    const entries = (await fs.readdir(baseOutDir, {
      withFileTypes: true
    } as any)) as unknown as Dirent[]

    // Look for directories that start with ASIN (supports both old and new formats)
    // Old format: "ASIN"
    // New format: "ASIN-Book Title"
    const match = entries.find(
      (e) =>
        e.isDirectory() && e.name.toLowerCase().startsWith(asin.toLowerCase())
    )
    if (match) return path.join(baseOutDir, match.name)
  } catch {}

  return path.join(baseOutDir, asin)
}

// Create a timestamped log file in the given outDir and redirect console output to it.
// Returns the path of the log file and a function to append custom messages.
export async function setupTimestampedLogger(outDir: string) {
  const logsDir = path.join(outDir, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const now = new Date()
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
  const logPath = path.join(logsDir, `${timestamp}.log`)

  const append = (message: string) => {
    void fs.appendFile(logPath, message + '\n').catch(() => {})
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

  console.log = (...args: any[]) => append(formatArgs(args))
  console.warn = (...args: any[]) => append(formatArgs(args))
  console.error = (...args: any[]) => append(formatArgs(args))

  return { logPath, append }
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
