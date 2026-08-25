// Characterization matrix: what `findFilterForCommand` does with COMPOUND
// commands, for every registered spec.
//
// `registry.test.ts` covers the compound rules with a handful of hand-picked
// examples. This file covers them for all 104 specs at once, because the rules
// are where the traffic is: measured over 19,060 recorded Bash calls, 51.9% of
// output chars come from a command with a non-reducer pipe, 10.3% from a chain
// whose segments resolve to different filters, 3.6% from subshells and control
// flow, and 2.2% from a trailing reducer pipe over a base with no filter. Only
// 25.5% is atomic enough for the registry to answer at all.
//
// It asserts CURRENT behavior, deliberately — including behavior that is about
// to change. When a coming change moves a line here, that is the point: the
// diff names exactly which spec × shape it moved, so an intended widening can
// be told apart from collateral damage. Update the expectations WITH the change
// and say why in the commit; do not loosen an assertion to make it pass.
//
// Deviations from a shape's rule are pinned by name in DEVIATIONS rather than
// absorbed into a looser assertion, and a deviation that stops deviating fails
// too — a stale exception is how a matrix quietly stops covering anything.

import { describe, expect, test } from 'bun:test'
import {
  applyBashFilterToStdout,
  planBashFilter,
} from 'src/tools/shared/outputFilter/Bash/index.js'
import { SPEC_COMMANDS } from 'src/tools/shared/outputFilter/Bash/filters/__testutils__/specCommands.js'
import { findFilterForCommand } from 'src/tools/shared/outputFilter/Bash/registry.js'

// ---------------------------------------------------------------------------
// The five shapes, and what today's registry answers for each
// ---------------------------------------------------------------------------

type Shape = {
  /** Test name and DEVIATIONS key. */
  readonly id: string
  readonly wrap: (command: string) => string
  /** Spec the wrapped command resolves to, given the spec the bare one does. */
  readonly resolves: (specName: string) => string | null
  /** Why the rule holds — the code path, not the intent. */
  readonly because: string
}

const SHAPES: readonly Shape[] = [
  {
    id: 'cd X && CMD',
    wrap: command => `cd /tmp && ${command}`,
    resolves: name => name,
    because:
      'splitTopLevelSegments yields [cd, CMD]; cd matches no spec, so the chain agrees on CMD',
  },
  {
    id: 'echo "===" && CMD',
    wrap: command => `echo "=== label" && ${command}`,
    resolves: name => name,
    because: 'same as the cd chain — echo matches no spec, and the quoted === does not split',
  },
  {
    id: 'CMD | tail -20',
    wrap: command => `${command} | tail -20`,
    resolves: name => name,
    because: 'splitTrailingReducerPipe strips the pure reducer and re-resolves against the base',
  },
  {
    id: 'CMD | grep foo',
    wrap: command => `${command} | grep foo`,
    resolves: () => null,
    because: 'a non-reducer pipe transforms the output, so splitTopLevelSegments refuses to split',
  },
  {
    id: 'cd X && CMD | tail -20',
    wrap: command => `cd /tmp && ${command} | tail -20`,
    resolves: name => name,
    because:
      'splitTrailingReducerPipe crosses the top-level && to reach the trailing reducer, then the chain resolves as the cd shape',
  },
  {
    id: 'CMD && ls -la',
    wrap: command => `${command} && ls -la`,
    resolves: name => (name === 'ls-la' ? 'ls-la' : null),
    because: 'two segments resolving to different specs disagree, and disagreement bypasses',
  },
]

/**
 * Specs that do not follow their shape's rule, with the reason. Keyed by shape
 * id, then spec name; the value is what the registry actually answers today.
 */
const DEVIATIONS: Record<string, Record<string, { routes: string | null; why: string }>> = {}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const SPEC_ENTRIES = Object.entries(SPEC_COMMANDS)

function expectedFor(shape: Shape, specName: string): string | null {
  const pinned = DEVIATIONS[shape.id]?.[specName]
  return pinned ? pinned.routes : shape.resolves(specName)
}

describe('compound routing — every spec × every shape', () => {
  for (const shape of SHAPES) {
    test(`${shape.id} — ${shape.because}`, () => {
      const wrong: string[] = []
      for (const [specName, command] of SPEC_ENTRIES) {
        const wrapped = shape.wrap(command)
        const actual = findFilterForCommand(wrapped)?.name ?? null
        const want = expectedFor(shape, specName)
        if (actual !== want) {
          wrong.push(`${specName}: ${JSON.stringify(wrapped)} → ${actual} (expected ${want})`)
        }
      }
      expect(wrong).toEqual([])
    })
  }

  test('the matrix covers every registered spec', () => {
    expect(SPEC_ENTRIES.length).toBeGreaterThan(100)
  })

  test('no DEVIATIONS entry has stopped deviating', () => {
    const stale: string[] = []
    for (const shape of SHAPES) {
      for (const [specName, pinned] of Object.entries(DEVIATIONS[shape.id] ?? {})) {
        if (shape.resolves(specName) === pinned.routes) {
          stale.push(`${shape.id} / ${specName}: now matches the rule, drop the exception`)
        }
      }
    }
    expect(stale).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The short-circuit invariant
// ---------------------------------------------------------------------------

// `bun-test` is the worked example because its sentinel is the dangerous kind:
// BUN_TEST_OK is `/^\s*\d+\s+pass\s*$/m`, so a `12 pass` line ANYWHERE in the
// body arms it, and firing replaces the WHOLE body with one line. On a compound
// command the body is two segments concatenated, so a sentinel earned by the
// second one would silently delete the first one's output.
//
// `applyBashFilterToStdout` guards this by passing `allowShortCircuit:
// !plan.isCompound`. These two tests are the before/after of that flag: same
// spec, same body, differing only in whether the command was compound.

/** Output of the first segment — must survive a compound run. */
const FIRST_SEGMENT_OUTPUT = 'node v22.12.0'
/**
 * A clean bun-test tail. Deliberately free of `FAIL`, `panic`, `error` and any
 * `[1-9]N fail` line, all of which are in BUN_TEST_HAS_PROBLEM and would
 * suppress the sentinel — making the test pass for the wrong reason.
 */
const CLEAN_BUN_TEST_TAIL = ' 12 pass\n 0 fail'
const BUN_TEST_SENTINEL = '✓ bun test: all tests passed'

describe('compound commands never short-circuit on a sentinel', () => {
  test('the premise: `node --version` matches no spec, so the chain agrees on bun-test', () => {
    // If a `node` spec is ever registered this stops being a chain that agrees,
    // and the two tests below would compare the wrong thing.
    expect(findFilterForCommand('node --version')).toBeNull()
    const plan = planBashFilter('node --version && bun test')
    expect(plan.filter?.name).toBe('bun-test')
    expect(plan.isCompound).toBe(true)
  })

  test('atomic: the sentinel fires and replaces the body', () => {
    const plan = planBashFilter('bun test')
    expect(plan.isCompound).toBe(false)
    const out = applyBashFilterToStdout(
      `${FIRST_SEGMENT_OUTPUT}\n${CLEAN_BUN_TEST_TAIL}`,
      false,
      plan,
    )
    expect(out).toContain(BUN_TEST_SENTINEL)
    // The whole body is gone — which is correct for an atomic `bun test`, and
    // is exactly what must NOT happen when a sibling segment produced part of it.
    expect(out).not.toContain(FIRST_SEGMENT_OUTPUT)
  })

  test('compound: the sentinel is suppressed and the sibling segment survives', () => {
    const plan = planBashFilter('node --version && bun test')
    const out = applyBashFilterToStdout(
      `${FIRST_SEGMENT_OUTPUT}\n${CLEAN_BUN_TEST_TAIL}`,
      false,
      plan,
    )
    expect(out).toContain(FIRST_SEGMENT_OUTPUT)
    expect(out).not.toContain(BUN_TEST_SENTINEL)
  })
})
