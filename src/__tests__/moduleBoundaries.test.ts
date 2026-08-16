import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { expect, test } from 'bun:test'

// The reorg (2026-08) exists to kill the catch-all directories: seven top-level
// buckets that grew by accretion because "where does this go?" had no answer,
// and that forced `/diff` to reach across eleven of them. Every file now lives
// in the feature slice that owns it.
//
// Nothing structural stops them coming back. A single `src/utils/foo.ts` added
// in a hurry re-opens the bucket, and the next twenty files follow it in — that
// is exactly how they formed the first time. This test is the only thing that
// makes their return visible.
//
// If you are here because this test failed: the fix is to put the file in the
// slice that owns it, not to add the directory to the list below. `src/shared/`
// is where genuinely cross-cutting primitives go.

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')

const RETIRED_CATCH_ALLS = [
  'src/components',
  'src/services',
  'src/utils',
  'src/screens',
  'src/constants',
  'src/hooks',
  'src/types',
]

test('the retired catch-all directories have not come back', () => {
  const resurrected = RETIRED_CATCH_ALLS.filter(d =>
    existsSync(join(REPO_ROOT, d)),
  )
  expect(resurrected).toEqual([])
})

// `src/constants/` and `src/types/` are the two that read as harmless — they
// sound like they hold only leaf data. They did not: `constants/` held the
// entire system prompt (`prompts.ts`, 2.5k lines, now `src/agent/prompts/`) and
// `types/` held `Tool`'s own type surface. Names that sound leaf-level are the
// ones that collect the most.
test('the slices that absorbed the catch-alls are where the tree says they are', () => {
  for (const p of [
    'src/agent/prompts/prompts.ts',
    'src/tools/tools.ts',
    'src/tools/Tool.ts',
    'src/shared/constants/product.ts',
    'src/shared/types/tools.ts',
  ]) {
    expect({ path: p, exists: existsSync(join(REPO_ROOT, p)) }).toEqual({
      path: p,
      exists: true,
    })
  }
})

// The move is only half the reorg. The other half is that a cross-slice import
// is written as `src/platform/foo.js`, never as `../../platform/foo.js` — a
// relative one compiles, bundles and passes every gate while encoding the
// distance between two slices, so the next move of EITHER file re-derives a
// `../` chain and nothing reports it if the new chain happens to resolve.
//
// This test resolves the target instead of banning the shape, because the
// exception is load-bearing: an import of a module this fork never received (a
// `.d.ts` with no `.ts`/`.tsx` beside it) MUST stay relative. `scripts/build/build.ts`
// only stubs a missing module when the specifier starts with `./` or `../`, so
// aliasing one trades a green build for a hard resolver failure — see
// `.claudin/rules/build-system.md` and the note in `scripts/migrations/reorg/apply.ts`.
// Every cross-slice relative specifier left in the tree is one of those.

const RELATIVE_SPECIFIER =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|mock\.module\(\s*)['"](\.\.\/[^'"]+)['"]/g

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/** The top-level slice a path belongs to: `src/agent/repl/REPL.tsx` → `agent`. */
function sliceOf(absPath: string): string {
  return relative(SRC_ROOT, absPath).split(sep)[0] ?? ''
}

test('a cross-slice import that CAN be aliased is aliased', () => {
  const violations: string[] = []

  for (const file of sourceFiles(SRC_ROOT)) {
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(RELATIVE_SPECIFIER)) {
      const specifier = match[1] ?? ''
      const target = resolve(dirname(file), specifier)
      if (sliceOf(target) === sliceOf(file)) continue
      const backing = [
        target.replace(/\.jsx?$/, '.ts'),
        target.replace(/\.jsx?$/, '.tsx'),
        `${target}.ts`,
        `${target}.tsx`,
      ]
      // No real module behind it: this fork never received it, and the relative
      // form is what keeps the build stubbing it instead of failing on it.
      if (!backing.some(existsSync)) continue
      violations.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
    }
  }

  expect(violations).toEqual([])
})
