import { describe, expect, test } from 'bun:test'
import { chooseDiffStatScope } from 'src/vcs/git/gitDiff.js'

const HEAD = '1111111111111111111111111111111111111111'
const BASE = '2222222222222222222222222222222222222222'

describe('chooseDiffStatScope', () => {
  test('diffs against the merge-base when the branch has diverged', () => {
    expect(chooseDiffStatScope(HEAD, BASE, 'main')).toEqual({
      kind: 'branch',
      against: BASE,
      base: 'main',
    })
  })

  test('falls back to HEAD when merge-base IS HEAD', () => {
    // Sitting on the base branch: `diff <mergeBase>` and `diff HEAD` are then
    // the same command, so the second probe buys nothing and the readout would
    // claim a branch total that is really just the working tree.
    expect(chooseDiffStatScope(HEAD, HEAD, 'main')).toEqual({ kind: 'uncommitted' })
  })

  test('falls back to HEAD when merge-base could not be resolved', () => {
    // Detached HEAD, shallow clone, or no such base branch.
    expect(chooseDiffStatScope(HEAD, null, 'main')).toEqual({ kind: 'uncommitted' })
  })

  test('falls back to HEAD when the head sha is unavailable', () => {
    // An unborn branch reports no HEAD; without it the equality test below
    // cannot run, and guessing `branch` would mislabel the numbers.
    expect(chooseDiffStatScope('', BASE, 'main')).toEqual({ kind: 'uncommitted' })
  })

  test('carries the base name through for the label', () => {
    const scope = chooseDiffStatScope(HEAD, BASE, 'origin/release-2')
    expect(scope).toEqual({ kind: 'branch', against: BASE, base: 'origin/release-2' })
  })
})
