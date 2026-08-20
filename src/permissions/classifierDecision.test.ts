import { describe, expect, test } from 'bun:test'
import {
  isAutoModeAllowlistedReadOnlyToolUse,
  isAutoModeAllowlistedTool,
} from 'src/permissions/classifierDecision.js'
import { isReadOnlyGitBatch } from 'src/tools/GitTool/grammar.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'

describe('isAutoModeAllowlistedTool', () => {
  test('Git is not on the name allowlist — it is decided per call', () => {
    expect(isAutoModeAllowlistedTool(GIT_TOOL_NAME)).toBe(false)
  })
})

describe('isAutoModeAllowlistedReadOnlyToolUse', () => {
  // The wiring in permissions.ts cannot be reached from here: `feature()` is
  // false for every flag under `bun test`, so the whole TRANSCRIPT_CLASSIFIER
  // branch that consults this predicate is compiled out. These pin the
  // predicate itself; the call site is verified against a built bundle.
  test('a read-only Git call skips the classifier', () => {
    expect(isAutoModeAllowlistedReadOnlyToolUse(GIT_TOOL_NAME, () => true)).toBe(
      true,
    )
  })

  test('a mutating Git call still reaches the classifier', () => {
    expect(
      isAutoModeAllowlistedReadOnlyToolUse(GIT_TOOL_NAME, () => false),
    ).toBe(false)
  })

  test('a tool outside the opt-in list is never skipped, read-only or not', () => {
    // BashTool.isReadOnly answers true for `ls`; the classifier is what guards
    // Bash in auto mode, so the name gate has to come first.
    expect(isAutoModeAllowlistedReadOnlyToolUse('Bash', () => true)).toBe(false)
  })

  test('a predicate that throws falls through to the classifier', () => {
    expect(
      isAutoModeAllowlistedReadOnlyToolUse(GIT_TOOL_NAME, () => {
        throw new Error('input did not parse')
      }),
    ).toBe(false)
  })

  test('the real Git predicate decides the three batch shapes', () => {
    const skips = (commands: string[]) =>
      isAutoModeAllowlistedReadOnlyToolUse(GIT_TOOL_NAME, () =>
        isReadOnlyGitBatch(commands),
      )
    expect(skips(['git status --short', 'git log -5'])).toBe(true)
    expect(skips(['git checkout -b feat/x'])).toBe(false)
    // Mixed batches fail closed: one mutation classifies the whole call.
    expect(skips(['git status --short', 'git push'])).toBe(false)
  })
})
