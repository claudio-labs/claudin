import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { expect, test } from 'bun:test'

// `mock.module(specifier, …)` is resolved by Bun at call time, and a specifier
// that resolves to nothing is NOT an error — the override is registered against
// a module id nobody ever imports, so the call silently does nothing and the
// test around it passes while mocking none of what it names.
//
// That is not hypothetical. Three calls in `cacheBoundsInvariants.test.ts` named
// `../../utils/debug.js`, `../../utils/log.js` and `../../utils/slowOperations.js`
// — `src/utils/` was retired by the 2026-08 reorg, so all three had been inert
// since the move. `moduleBoundaries.test.ts` could not see them either: it skips
// any cross-slice relative specifier with no module behind it, because THAT is
// how this fork's missing-module stubs legitimately look.
//
// So the two tests split the job. That one asks "is this import written as an
// alias"; this one asks "does this mock name a module that exists at all".

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')

const MOCK_MODULE_SPECIFIER = /mock\.module\(\s*['"]([^'"]+)['"]/g

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/**
 * Prose mentioning a mock is not a mock: `mcp/client.regression.test.ts`
 * explains in a comment which specifier a sibling file mocks, and that sentence
 * names a path deliberately abbreviated to `.../client.js`.
 */
function insideComment(code: string, matchIndex: number): boolean {
  const lineStart = code.lastIndexOf('\n', matchIndex) + 1
  const prefix = code.slice(lineStart, matchIndex)
  return prefix.includes('//') || prefix.trimStart().startsWith('*')
}

/**
 * The absolute path a specifier points at, or `null` for a bare package name
 * (`child_process`, `lru-cache`, `@anthropic-ai/sdk`) — those resolve through
 * node_modules and are none of this test's business.
 */
function targetOf(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  if (specifier.startsWith('src/')) return join(REPO_ROOT, specifier)
  return null
}

/**
 * Source is written with `.js` specifiers that resolve to `.ts`/`.tsx`, and a
 * module this fork never received is backed by a `.d.ts` alone — which counts,
 * since `mock.module` on one of those is how a test stands in for an absent
 * subsystem.
 */
function hasBackingModule(target: string): boolean {
  const base = target.replace(/\.jsx?$/, '')
  return [
    target,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ].some(existsSync)
}

test('every mock.module target resolves to a real module', () => {
  const unresolved: string[] = []

  for (const file of sourceFiles(SRC_ROOT)) {
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(MOCK_MODULE_SPECIFIER)) {
      if (insideComment(code, match.index)) continue
      const specifier = match[1] ?? ''
      const target = targetOf(file, specifier)
      if (target === null) continue
      if (hasBackingModule(target)) continue
      unresolved.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
    }
  }

  expect(unresolved).toEqual([])
})

// A mock written as `../../platform/foo.js` from inside another slice survives
// the check above whenever the path happens to resolve, and then re-derives a
// wrong `../` chain the next time either file moves. Mocks take the same alias
// the imports take — the exception for a declaration-only module is the reason
// this is reported separately rather than folded into the test above.
function sliceOf(absPath: string): string {
  return relative(SRC_ROOT, absPath).split(sep)[0] ?? ''
}

test('a cross-slice mock.module specifier is written as an alias', () => {
  const violations: string[] = []

  for (const file of sourceFiles(SRC_ROOT)) {
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(MOCK_MODULE_SPECIFIER)) {
      if (insideComment(code, match.index)) continue
      const specifier = match[1] ?? ''
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      if (sliceOf(target) === sliceOf(file)) continue
      const base = target.replace(/\.jsx?$/, '')
      // Declaration-only: the fork never received the module, and the relative
      // form is what keeps the build stubbing it instead of failing on it.
      if (existsSync(`${base}.d.ts`)) continue
      violations.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
    }
  }

  expect(violations).toEqual([])
})
