// Snapshot of the public surface of src/utils/sessionStorage. This pins the
// 11c-split barrel: if any of the 5 sub-modules (pure/, persistence/, resume/,
// indexing/) drops a re-export or accidentally exports a new symbol, this
// snapshot diff catches it in a single assertion. Across 32 importers, a
// missing name breaks builds; an unintended new name leaks internals.
//
// To update intentionally: `bun test --update-snapshots
// src/utils/sessionStorage/__tests__/barrelExports.test.ts`, then explain
// the diff in the PR.

import { describe, expect, test } from 'bun:test'
import * as ss from 'src/utils/sessionStorage.js'

describe('sessionStorage barrel', () => {
  test('exports a stable, known set of runtime symbols', () => {
    const names = Object.keys(ss).sort()
    expect(names).toMatchSnapshot()
  })

  test('every named export resolves (no undefined re-exports)', () => {
    const broken: string[] = []
    for (const name of Object.keys(ss)) {
      if ((ss as Record<string, unknown>)[name] === undefined) broken.push(name)
    }
    expect(broken).toEqual([])
  })
})
