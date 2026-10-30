/**
 * The build defines `MACRO.*` member by member (`scripts/build/build.ts`), never
 * `MACRO` itself, so in the bundle `typeof MACRO` is 'undefined' and a guard on
 * it always takes its fallback. Four did: every transcript record said
 * `"version":"unknown"`, the doctor did too, and the xAI user agent was
 * `claudin/dev` (2026-10-30 census). Read the real version through
 * `getDisplayVersion()` (`src/platform/buildVersion.ts`) instead.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const GUARD_RE = /typeof\s+MACRO\b/
const SOURCE_RE = /\.tsx?$/
const SKIPPED_RE = /\.test\.tsx?$|\.d\.ts$/

function trackedSources(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', '-z', 'src'], { cwd: REPO_ROOT })
  if (out.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${out.stderr.toString()}`)
  }
  return out.stdout
    .toString()
    .split('\0')
    .filter(file => SOURCE_RE.test(file) && !SKIPPED_RE.test(file))
}

test('no source guards a build constant with typeof MACRO', () => {
  const files = trackedSources()
  // A listing that found nothing would pass while checking nothing.
  expect(files.length).toBeGreaterThan(1000)

  const offenders: string[] = []
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (GUARD_RE.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  expect(offenders).toEqual([])
})
