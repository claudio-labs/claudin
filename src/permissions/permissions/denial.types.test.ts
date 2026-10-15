/**
 * Type-level tests for the auto-mode block path in `denial.ts`.
 *
 * "A classifier block never becomes an allow" is the guarantee auto mode rests
 * on, and the branch that calls these functions (`permissions.ts`, behind
 * `feature('TRANSCRIPT_CLASSIFIER')`) never runs under `bun test`. So the
 * guarantee lives in the return types, and these assertions put a widening of
 * either one — to `PermissionDecision`, say — back at the definition, as a
 * `typecheck:ci` error.
 *
 * Checked by `tsc`, not by the runner: the `test()` below is the runtime half,
 * every combination of the block's flags, interactive and headless.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { Equal, Expect } from 'src/shared/types/typeAssertions.js'
import { AbortError } from 'src/shared/errors.js'
import { createDenialTrackingState } from 'src/permissions/denialTracking.js'
import {
  decideClassifierBlock,
  type handleDenialLimitExceeded,
} from 'src/permissions/permissions/denial.js'

type _Block = Expect<Equal<ReturnType<typeof decideClassifierBlock>['behavior'], 'ask' | 'deny'>>
type _Limit = Expect<
  Equal<NonNullable<ReturnType<typeof handleDenialLimitExceeded>>['behavior'], 'ask'>
>

const FLAGS = ['refused', 'timedOut', 'unavailable', 'transcriptTooLong', 'deterministic'] as const

describe('a classifier block', () => {
  test('is never an allow, for any combination of flags', () => {
    for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
      for (const headless of [false, true]) {
        const flags = Object.fromEntries(FLAGS.map((f, i) => [f, (mask & (1 << i)) !== 0]))
        const context = { localDenialTracking: createDenialTrackingState() } as unknown as ToolUseContext
        try {
          const decision = decideClassifierBlock({
            classifierResult: { reason: 'blocked', model: 'claude-sonnet-5-5', ...flags },
            ask: { behavior: 'ask', message: 'Allow?' },
            appState: { toolPermissionContext: { shouldAvoidPermissionPrompts: headless } },
            denialState: createDenialTrackingState(),
            context,
            toolName: 'Bash',
          })
          expect(['ask', 'deny']).toContain(decision.behavior)
        } catch (e) {
          expect(e).toBeInstanceOf(AbortError)
          expect(headless).toBe(true)
        }
      }
    }
  })
})
