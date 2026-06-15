#!/usr/bin/env node
/**
 * PII / private-data guard for commits.
 *
 * Blocks a commit when staged changes (pre-commit) or the commit message
 * (commit-msg) leak private data:
 *   - secrets: API keys (OpenAI `sk-…`, AWS `AKIA…`), email addresses
 *   - Amazon book identifiers (ASINs, `B0` + 8 chars)
 *   - the owner's actual book titles, derived at runtime from the local `out/`
 *     directory (their personal library), so generic example titles are allowed
 *     but real ones are caught.
 *
 * It does NOT auto-edit anything — it reports the offending lines and exits
 * non-zero so the author removes them. Bypass for a one-off with
 * `SKIP_PII_CHECK=1 git commit …` or `git commit --no-verify`.
 *
 * Usage:
 *   node scan-pii.mjs staged              # scan staged additions (pre-commit)
 *   node scan-pii.mjs message <msgFile>   # scan commit message (commit-msg)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.SKIP_PII_CHECK) process.exit(0)

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..')

// Emails that are legitimate project metadata, not the owner's PII.
const EMAIL_ALLOWLIST = new Set([
  'travis@transitivebullsh.it',
  'noreply@anthropic.com'
])
const EMAIL_ALLOWED_DOMAINS = ['users.noreply.github.com']

// ASINs that are the project's documented public examples, not the owner's PII.
const ASIN_ALLOWLIST = new Set(['B0819W19WD'])

// High-signal secret / identifier patterns.
const PATTERNS = [
  { label: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: 'Amazon ASIN',
    re: /\bB0[A-Z0-9]{8}\b/g,
    allow: (m) => ASIN_ALLOWLIST.has(m)
  },
  {
    label: 'Amazon credential',
    re: /AMAZON_(?:EMAIL|PASSWORD)\s*[:=]\s*['"]?[^'"\s]+/gi
  }
]

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// Owner's real book titles, derived from the (gitignored) local library so the
// list stays current without hardcoding anyone's reading habits into the repo.
function loadBookTitles() {
  const outDir = path.join(repoRoot, 'out')
  let names = []
  try {
    names = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  const titles = new Set()
  for (const name of names) {
    const title = name
      .replace(/^B0[A-Z0-9]{8}-?/, '') // strip ASIN prefix
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    // Only distinctive multi-word titles — short/common single words (e.g.
    // "Switch", "Build") would false-positive on ordinary code.
    if (title.split(' ').length >= 3 && title.length >= 14) {
      titles.add(title.toLowerCase())
    }
  }
  return [...titles]
}

const BOOK_TITLES = loadBookTitles()

function findInLine(line) {
  const hits = []
  for (const { label, re, allow } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(line)) !== null) {
      if (allow && allow(m[0])) continue
      hits.push(`${label}: ${m[0]}`)
    }
  }
  let em
  EMAIL_RE.lastIndex = 0
  while ((em = EMAIL_RE.exec(line)) !== null) {
    const email = em[0]
    const domain = email.slice(email.indexOf('@') + 1).toLowerCase()
    if (EMAIL_ALLOWLIST.has(email.toLowerCase())) continue
    if (EMAIL_ALLOWED_DOMAINS.some((d) => domain.endsWith(d))) continue
    hits.push(`email address: ${email}`)
  }
  const lower = line.toLowerCase()
  for (const title of BOOK_TITLES) {
    if (lower.includes(title)) hits.push(`book title: "${title}"`)
  }
  return hits
}

function scanStaged() {
  const diff = execFileSync(
    'git',
    ['diff', '--cached', '--no-color', '-U0', '--diff-filter=ACM'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const findings = []
  let file = '(unknown)'
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.replace(/^\+\+\+ (b\/)?/, '')
      continue
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue
    const added = raw.slice(1)
    for (const hit of findInLine(added)) findings.push({ where: file, hit })
  }
  return findings
}

function scanMessage(msgFile) {
  let text = ''
  try {
    text = fs.readFileSync(msgFile, 'utf8')
  } catch {
    return []
  }
  const findings = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue // git comment lines
    for (const hit of findInLine(line))
      findings.push({ where: 'commit message', hit })
  }
  return findings
}

const mode = process.argv[2]
const findings =
  mode === 'message' ? scanMessage(process.argv[3]) : scanStaged()

if (findings.length === 0) process.exit(0)

console.error('\n[31m✖ Commit blocked: private data detected.[0m')
for (const { where, hit } of findings) {
  console.error(`  • ${where}: ${hit}`)
}
console.error(
  '\nRemove the book titles / PII / secrets above before committing.' +
    '\nUse neutral placeholders that do not match the patterns (e.g. an ASIN like' +
    ' ASIN000001 — not starting with "B0" — and "Example Book").' +
    '\nIf this is a false positive, bypass once with: SKIP_PII_CHECK=1 git commit …\n'
)
process.exit(1)
