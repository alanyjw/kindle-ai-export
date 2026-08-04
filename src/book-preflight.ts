import type { BookFlags } from './book-flags'
import type { BookTarget } from './book-input'

export type SourceFileProbe = 'ok' | 'missing' | 'unreadable'

export interface PreflightEnv {
  TTS_ENGINE?: string | undefined
  OPENAI_API_KEY?: string | undefined
  UNREAL_SPEECH_API_KEY?: string | undefined
  AMAZON_EMAIL?: string | undefined
  AMAZON_PASSWORD?: string | undefined
}

export interface PreflightProbes {
  hasFfmpeg: boolean
  sourceFile?: SourceFileProbe | undefined
  hasContentJson?: boolean | undefined
}

function audioProblems(
  flags: BookFlags,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  if (!flags.audio) return []

  // Mirrors the engine default in export-book-audio.ts:66.
  const engine = env.TTS_ENGINE || 'openai'
  const credential =
    engine === 'unrealspeech'
      ? { name: 'UNREAL_SPEECH_API_KEY', value: env.UNREAL_SPEECH_API_KEY }
      : { name: 'OPENAI_API_KEY', value: env.OPENAI_API_KEY }

  return [
    ...(credential.value
      ? []
      : [
          `--audio requires ${credential.name} (TTS_ENGINE=${engine}); set it in .env`
        ]),
    ...(probes.hasFfmpeg
      ? []
      : [
          '--audio requires ffmpeg on PATH; install it with `brew install ffmpeg`'
        ])
  ]
}

function targetProblems(
  target: BookTarget,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  switch (target.kind) {
    case 'kindle':
      return [
        ...(env.AMAZON_EMAIL
          ? []
          : [
              'AMAZON_EMAIL is required to extract a Kindle book; set it in .env'
            ]),
        ...(env.AMAZON_PASSWORD
          ? []
          : [
              'AMAZON_PASSWORD is required to extract a Kindle book; set it in .env'
            ])
      ]

    case 'pdf':
    case 'epub':
      if (probes.sourceFile === 'missing') {
        return [`source file not found: ${target.sourcePath}`]
      }
      if (probes.sourceFile === 'unreadable') {
        return [
          `source file exists but could not be read: ${target.sourcePath}\n` +
            '    On macOS, files in iCloud Drive fail with EPERM until the terminal is\n' +
            '    granted Full Disk Access (System Settings → Privacy & Security).'
        ]
      }
      return []

    case 'outdir':
      return probes.hasContentJson
        ? []
        : [`no content.json in ${target.outDir}; nothing to export`]
  }
}

/**
 * Return human-readable descriptions of every unmet requirement, or an empty
 * array when the run can proceed.
 *
 * Pure: the caller performs the I/O probes (a PATH lookup for ffmpeg, an R_OK
 * access check on the source file) and passes the results in.
 */
export function checkPreflight(
  target: BookTarget,
  flags: BookFlags,
  env: PreflightEnv,
  probes: PreflightProbes
): string[] {
  return [
    ...audioProblems(flags, env, probes),
    ...targetProblems(target, env, probes)
  ]
}
