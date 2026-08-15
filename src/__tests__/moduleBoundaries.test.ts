import { existsSync } from 'fs'
import { join } from 'path'
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
