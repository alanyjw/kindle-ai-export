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
      (e) => e.isDirectory() && e.name.toLowerCase().startsWith(asin.toLowerCase())
    )
    if (match) return path.join(baseOutDir, match.name)
  } catch {}

  return path.join(baseOutDir, asin)
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
