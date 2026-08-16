import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { Glob } from 'bun'
import { REPO_ROOT } from './repoRoot'

// ---------------------------------------------------------------------------
// Guard: `scripts/` is invisible to every other gate.
//
// tsconfig.json includes `src/**` only, so `bun run typecheck` never looks at
// a script; the build only reads `build.ts`; and most scripts here are release-
// or bench-only, so no test imports them. A script that names REPO_ROOT without
// importing it is a plain ReferenceError that nothing reports until the release
// workflow runs it on all six platforms — which is exactly what happened to
// vendor-ripgrep.ts and vendor-sharp.ts in the 2026-08-16 reorg.
//
// The second assertion catches the quieter half of the same bug: a root derived
// by counting `..` from the file's own depth still resolves after a move, just
// to the wrong directory. code-outline-bench.ts spent that reorg globbing
// `src/**` under `scripts/bench/` and measuring an empty corpus.
// ---------------------------------------------------------------------------

const files = [...new Glob('scripts/**/*.{ts,mjs}').scanSync(REPO_ROOT)].filter(
  f => !f.includes('/migrations/'), // one-shot codemods, kept as they ran
)

/** Reads the repo root from its own depth instead of importing repoRoot.ts. */
const HAND_COUNTED_ROOT =
  /(?:resolve|join)\s*\(\s*(?:import\.meta\.dir|__dirname)\s*,\s*['"]\.\.['"]|new URL\(\s*['"]\.\.\//

// Both exceptions are published to npm, where `scripts/repoRoot.ts` is not:
// package.json `files` ships these two .mjs alone, and node runs them with no
// TS loader. They must keep deriving the root themselves.
const MAY_COUNT_LEVELS = new Set([
  'scripts/repoRoot.ts', // the one file allowed to, by definition
  'scripts/postinstall-warmup.mjs',
  'scripts/v8cache-gc.mjs',
])

describe('scripts/ repo-root discipline', () => {
  test('the corpus is actually being scanned', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  test('every script naming REPO_ROOT imports it', () => {
    const offenders = files.filter(f => {
      if (f === 'scripts/repoRoot.ts') return false
      const src = readFileSync(`${REPO_ROOT}/${f}`, 'utf-8')
      if (!src.includes('REPO_ROOT')) return false
      return !/import\s*\{[^}]*\bREPO_ROOT\b[^}]*\}\s*from\s*['"][^'"]*repoRoot/.test(
        src,
      )
    })
    expect(offenders).toEqual([])
  })

  test('no script derives the repo root from its own depth', () => {
    const offenders = files.filter(f => {
      if (MAY_COUNT_LEVELS.has(f)) return false
      const src = readFileSync(`${REPO_ROOT}/${f}`, 'utf-8')
      return src
        .split('\n')
        .filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
        .some(l => HAND_COUNTED_ROOT.test(l))
    })
    expect(offenders).toEqual([])
  })

  test('REPO_ROOT resolves to this checkout', () => {
    expect(relative(REPO_ROOT, import.meta.dir)).toBe('scripts')
  })
})
