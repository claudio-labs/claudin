import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addClippedIds,
  resetClippedIds,
} from 'src/services/compact/stableStubState.js'
import {
  MAX_CONSECUTIVE_DELTAS,
  _getRememberedCountForTesting,
  applyGitDelta,
  resetGitDelta,
} from 'src/tools/GitTool/delta.js'

const DIFF = 'git diff'

/**
 * A diff section with a realistic amount of body. Size matters here: the lane
 * declines when the delta is not meaningfully shorter than the full output, so
 * a toy three-line section would never be elided and the test would pass for
 * the wrong reason.
 */
function section(path: string, changed: string): string {
  const context = Array.from(
    { length: 30 },
    (_, i) => ` const untouched${i} = 'a line of surrounding context'`,
  )
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,32 +1,32 @@',
    ...context.slice(0, 15),
    ...changed.split('\n'),
    ...context.slice(15),
  ].join('\n')
}

const A_V1 = section('src/a.ts', ['-const a = 1', '+const a = 2'].join('\n'))
const A_V2 = section('src/a.ts', ['-const a = 1', '+const a = 3'].join('\n'))
const B = section('src/b.ts', ['-const b = 1', '+const b = 2'].join('\n'))
const C = section('src/c.ts', ['-const c = 1', '+const c = 2'].join('\n'))

const RUN_1 = [A_V1, B, C].join('\n')
/** Same B and C, changed A — the shape the lane exists for. */
const RUN_2 = [A_V2, B, C].join('\n')

function firstDelivery(id = 'toolu_1'): string {
  return applyGitDelta(DIFF, RUN_1, { full: false, toolUseId: id })
}

beforeEach(() => {
  resetGitDelta()
  resetClippedIds()
  delete process.env.CLAUDIN_DISABLE_GIT_DELTA
})

afterEach(() => {
  resetGitDelta()
  resetClippedIds()
  delete process.env.CLAUDIN_DISABLE_GIT_DELTA
})

describe('the lane itself', () => {
  test('first call returns the whole body, second elides only identical sections', () => {
    expect(firstDelivery()).toBe(RUN_1)

    const delta = applyGitDelta(DIFF, RUN_2, {
      full: false,
      toolUseId: 'toolu_2',
    })
    expect(delta).not.toBe(RUN_2)
    expect(delta.length).toBeLessThan(RUN_2.length)
    // The changed file's hunks are present in full...
    expect(delta).toContain('+const a = 3')
    // ...and the unchanged ones are not.
    expect(delta).not.toContain('+const b = 2')
    expect(delta).not.toContain('+const c = 2')
  })

  test('declines when nothing is identical', () => {
    firstDelivery()
    const allNew = [
      section('src/x.ts', '+x'),
      section('src/y.ts', '+y'),
      section('src/z.ts', '+z'),
    ].join('\n')
    expect(
      applyGitDelta(DIFF, allNew, { full: false, toolUseId: 'toolu_2' }),
    ).toBe(allNew)
  })

  test('declines on output that is not a diff', () => {
    const status = 'On branch main\nnothing to commit, working tree clean'
    expect(
      applyGitDelta('git status', status, { full: false, toolUseId: 'a' }),
    ).toBe(status)
    expect(
      applyGitDelta('git status', status, { full: false, toolUseId: 'b' }),
    ).toBe(status)
  })
})

describe('rule 1 — never elide what the model can no longer see', () => {
  test('a clipped previous delivery forces the full body', () => {
    firstDelivery('toolu_clipped')
    addClippedIds(['toolu_clipped'])

    expect(
      applyGitDelta(DIFF, RUN_2, { full: false, toolUseId: 'toolu_2' }),
    ).toBe(RUN_2)
  })

  test('an absent toolUseId forces the full body and remembers nothing', () => {
    expect(applyGitDelta(DIFF, RUN_1, { full: false })).toBe(RUN_1)
    expect(_getRememberedCountForTesting()).toBe(0)

    // Even a second identical call cannot elide, because nothing was stored.
    expect(applyGitDelta(DIFF, RUN_2, { full: false })).toBe(RUN_2)
  })
})

describe('rule 2 — the stat table stays complete', () => {
  test('every file in the diff appears with its counts, elided or not', () => {
    firstDelivery()
    const delta = applyGitDelta(DIFF, RUN_2, {
      full: false,
      toolUseId: 'toolu_2',
    })

    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      expect(delta).toContain(path)
    }
    // Counts are present for the elided files too, not just the emitted one.
    expect(delta).toMatch(/src\/b\.ts\s+\+\d+ -\d+\s+\(unchanged, elided\)/)
    expect(delta).toMatch(/src\/c\.ts\s+\+\d+ -\d+\s+\(unchanged, elided\)/)
    expect(delta).toMatch(/src\/a\.ts\s+\+\d+ -\d+\s+\(below\)/)
  })
})

describe('rule 3 — a baseline move drops every remembered body', () => {
  test.each([
    ['git checkout other-branch', 'Switched to branch'],
    ['git switch main', 'Switched to branch'],
    ['git reset --hard HEAD~1', 'HEAD is now at 1234567'],
    ['git stash', 'Saved working directory'],
    ['git add -A', ''],
    ['git rebase main', 'Successfully rebased'],
    ['git merge main', 'Fast-forward'],
  ])('%s invalidates', (command, output) => {
    firstDelivery()
    expect(_getRememberedCountForTesting()).toBe(1)

    applyGitDelta(command, output, { full: false, toolUseId: 'toolu_op' })
    expect(_getRememberedCountForTesting()).toBe(0)

    // The next diff is therefore full, not a delta.
    expect(
      applyGitDelta(DIFF, RUN_2, { full: false, toolUseId: 'toolu_3' }),
    ).toBe(RUN_2)
  })

  test('a commit detected only from its output also invalidates', () => {
    firstDelivery()
    applyGitDelta('git commit -m wip', '[main 1a2b3c4] wip\n 1 file changed', {
      full: false,
      toolUseId: 'toolu_commit',
    })
    expect(_getRememberedCountForTesting()).toBe(0)
  })

  test('an unrelated read does NOT invalidate', () => {
    firstDelivery()
    applyGitDelta('git log --oneline -3', 'abc123 one\ndef456 two', {
      full: false,
      toolUseId: 'toolu_log',
    })
    expect(_getRememberedCountForTesting()).toBe(1)
  })

  // Recognising the subcommand through the grammar's tokenizer rather than a
  // regex fixed a real miss: `-c key=value` consumes a following token, so a
  // pattern that walks flags one at a time stops at `key=value` and never sees
  // the checkout.
  test.each([
    ['git -c core.pager=cat checkout main'],
    ['git -C /some/path reset --hard'],
    ['git --git-dir /tmp/x.git stash'],
  ])('%s invalidates despite the global options', command => {
    firstDelivery()
    applyGitDelta(command, '', { full: false, toolUseId: 'toolu_global' })
    expect(_getRememberedCountForTesting()).toBe(0)
  })

  // CodeQL flagged the previous pattern as exponentially backtracking: its two
  // alternatives matched the same text, so a long flag run that never reaches a
  // baseline-moving subcommand took 2^n steps. Any regression re-introducing a
  // pattern of that shape hangs here instead of in production.
  test('a pathological flag run is classified in linear time', () => {
    const command = `git\t${'--!\t'.repeat(64)}diff`
    const started = performance.now()
    firstDelivery()
    applyGitDelta(command, '', { full: false, toolUseId: 'toolu_redos' })
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('rule 4 — it re-arms', () => {
  test(`serves a full body again after ${MAX_CONSECUTIVE_DELTAS} deltas`, () => {
    firstDelivery()

    const shape: ('delta' | 'full')[] = []
    for (let i = 0; i < MAX_CONSECUTIVE_DELTAS + 2; i++) {
      // Alternate the changed section so every call has something to emit.
      const body = i % 2 === 0 ? RUN_2 : RUN_1
      const out = applyGitDelta(DIFF, body, {
        full: false,
        toolUseId: `toolu_${i + 2}`,
      })
      shape.push(out === body ? 'full' : 'delta')
    }

    const firstFull = shape.indexOf('full')
    expect(firstFull).toBe(MAX_CONSECUTIVE_DELTAS)
    // And it re-arms rather than stopping: deltas resume after the full body.
    expect(shape.slice(MAX_CONSECUTIVE_DELTAS + 1)).toContain('delta')
  })
})

describe('rule 5 — visible and escapable', () => {
  test('the delta names what was elided and how to get it all', () => {
    firstDelivery()
    const delta = applyGitDelta(DIFF, RUN_2, {
      full: false,
      toolUseId: 'toolu_2',
    })
    expect(delta).toContain('elided')
    expect(delta).toContain('full: true')
  })

  test('full: true returns the whole body', () => {
    firstDelivery()
    expect(
      applyGitDelta(DIFF, RUN_2, { full: true, toolUseId: 'toolu_2' }),
    ).toBe(RUN_2)
  })

  test('CLAUDIN_DISABLE_GIT_DELTA=1 turns the lane off', () => {
    process.env.CLAUDIN_DISABLE_GIT_DELTA = '1'
    expect(applyGitDelta(DIFF, RUN_1, { full: false, toolUseId: 'a' })).toBe(
      RUN_1,
    )
    expect(applyGitDelta(DIFF, RUN_2, { full: false, toolUseId: 'b' })).toBe(
      RUN_2,
    )
  })
})

describe('state is bounded', () => {
  test('remembered bodies never exceed the cap', () => {
    for (let i = 0; i < 200; i++) {
      applyGitDelta(`git diff HEAD~${i}`, RUN_1, {
        full: false,
        toolUseId: `toolu_${i}`,
      })
    }
    expect(_getRememberedCountForTesting()).toBeLessThanOrEqual(32)
  })
})
