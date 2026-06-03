import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { expect, test } from 'bun:test'

// Regression guard for ROADMAP item 10.1. `.claudin/rules/typescript-patterns.md`
// mandates `from 'zod/v4'` everywhere because `@anthropic-ai/sdk@0.96.0`+
// requires zod v4 types explicitly — any schema that leaks into the SDK can
// break silently on future upgrades if it was built with the bare `'zod'`
// import (which resolves to the union v3∪v4 entrypoint).
//
// This test walks src/ and scripts/ and fails if anything imports `from 'zod'`
// without the `/v4` subpath. Other subpaths (e.g. `zod/v4-mini`) are allowed.

const REPO_ROOT = join(import.meta.dir, '..')
const SCAN_DIRS = ['src', 'scripts']
const SCAN_EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])

// Bare `from 'zod'` or `from "zod"` (no subpath). Subpaths like `zod/v4` pass.
const BARE_ZOD_IMPORT_RE = /from\s+(['"])zod\1/

// Skip this guard file itself — it would self-match on the regex's source.
const GUARD_FILENAME = 'zod-v4-only-guard.test.ts'

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf('.')
      if (dot >= 0 && SCAN_EXTS.has(entry.slice(dot))) {
        out.push(full)
      }
    }
  }
}

test("all 'zod' imports use the 'zod/v4' subpath", () => {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files)

  const offenders: string[] = []
  for (const file of files) {
    if (file.endsWith(GUARD_FILENAME)) continue
    const src = readFileSync(file, 'utf-8')
    if (BARE_ZOD_IMPORT_RE.test(src)) {
      offenders.push(relative(REPO_ROOT, file))
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `Found ${offenders.length} file(s) importing from bare 'zod' instead of 'zod/v4'. ` +
        `See .claudin/rules/typescript-patterns.md. Offenders:\n  ` +
        offenders.join('\n  '),
    )
  }

  expect(offenders).toEqual([])
})
