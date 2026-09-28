/**
 * Scans the tracked tree against the reference, one row per file. Shared by
 * the census (the report) and provenance-ci.ts (the ratchet), so both always
 * count the same thing.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { CODE_EXTENSION, matchedLines, TEXT_EXTENSION } from './fingerprint.js'
import type { Reference } from './reference.js'

export type Row = {
  file: string
  /** Every line of the file, blank ones included. */
  lines: number
  /** Lines matching the Claude Code reference. */
  claudeCode: number
  /** Lines matching the openclaude reference and not already counted above. */
  openclaude: number
}

export type FileMatch = { claudeCode: Set<number>; openclaude: Set<number> }

const TEST_PATH = /\.test\.|\/__tests__\/|\/__testutils__\/|\/__fixtures__\//

export const isTestPath = (file: string) => TEST_PATH.test(file)

export const isScanned = (file: string) => CODE_EXTENSION.test(file) || TEXT_EXTENSION.test(file)

/** Tracked files plus untracked ones git does not ignore, so new work is seen before it is added. */
export function listFiles(root = REPO_ROOT): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`)
  return [...new Set(result.stdout.split('\0'))].filter(f => f !== '' && isScanned(f)).sort()
}

export function matchFile(file: string, source: string, reference: Reference): FileMatch {
  const withTokens = CODE_EXTENSION.test(file)
  const claudeCode = matchedLines(source, reference.claudeCode, withTokens)
  const openclaude = matchedLines(source, reference.openclaude, withTokens)
  for (const line of claudeCode) openclaude.delete(line)
  return { claudeCode, openclaude }
}

export function scanTree(reference: Reference, root = REPO_ROOT): Row[] {
  const rows: Row[] = []
  for (const file of listFiles(root)) {
    let source: string
    try {
      source = readFileSync(join(root, file), 'utf8')
    } catch {
      continue // deleted in the working tree but still in the index
    }
    const match = matchFile(file, source, reference)
    rows.push({
      file,
      lines: source.split('\n').length,
      claudeCode: match.claudeCode.size,
      openclaude: match.openclaude.size,
    })
  }
  return rows
}

/** `src/agent/…` → `src/agent`; `scripts/verify/…` → `scripts/verify`; anything else by its top directory. */
export function sliceOf(file: string): string {
  const parts = file.split('/')
  if (parts.length === 1) return '(root)'
  if ((parts[0] === 'src' || parts[0] === 'scripts') && parts.length > 2) return `${parts[0]}/${parts[1]}`
  return parts[0]!
}
