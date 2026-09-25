/**
 * Claude Code's internal codename prefixed every upstream analytics event and
 * remote feature-flag key. Both are gone (docs/tech/upstream-flags/README.md),
 * and so is the word: this fails if it comes back in a tracked file's path or
 * contents. The agent's memory notes under .claudin/memory/ are history and
 * are not checked. The word is assembled at runtime so this file does not
 * match itself.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CODENAME = ['ten', 'gu'].join('')
const EXCLUDED_PREFIXES = ['.claudin/memory/']
/** Bytes sniffed for a NUL to tell a binary file from text. */
const BINARY_SNIFF_BYTES = 8000

function trackedFiles(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: REPO_ROOT })
  if (out.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${out.stderr.toString()}`)
  }
  return out.stdout.toString().split('\0').filter(Boolean)
}

test('the upstream codename appears in no tracked file', () => {
  const files = trackedFiles().filter(
    file => !EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix)),
  )
  // A listing that found nothing would pass while checking nothing.
  expect(files.length).toBeGreaterThan(1000)

  const offenders: string[] = []
  for (const file of files) {
    if (file.toLowerCase().includes(CODENAME)) {
      offenders.push(`${file} (path)`)
      continue
    }
    const full = join(REPO_ROOT, file)
    if (!existsSync(full)) continue
    const bytes = readFileSync(full)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue
    const text = bytes.toString('utf8').toLowerCase()
    const at = text.indexOf(CODENAME)
    if (at !== -1) offenders.push(`${file}:${text.slice(0, at).split('\n').length}`)
  }
  expect(offenders).toEqual([])
})
