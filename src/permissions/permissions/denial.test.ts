import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import type { PermissionAskDecision } from 'src/shared/types/permissions.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { AbortError } from 'src/shared/errors.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
} from 'src/permissions/denialTracking.js'
import {
  classifierFallback,
  decideClassifierBlock,
  handleDenialLimitExceeded,
  persistDenialState,
} from 'src/permissions/permissions/denial.js'
import {
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
} from 'src/agent/messages/rejection.js'

const ASK: PermissionAskDecision = {
  behavior: 'ask',
  message: 'Allow Bash?',
  decisionReason: { type: 'other', reason: 'not on any list' },
}

/** A context whose denial state lives in the store, as for main and sync agents. */
function storeContext(initial?: DenialTrackingState) {
  let state = { denialTracking: initial } as unknown as AppState
  const context = {
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  } as unknown as ToolUseContext
  return { context, denialTracking: () => state.denialTracking, state: () => state }
}

function limit(denialState: DenialTrackingState, headless: boolean, context = storeContext().context) {
  return handleDenialLimitExceeded(
    denialState,
    { toolPermissionContext: { shouldAvoidPermissionPrompts: headless } },
    'rm outside the repo',
    ASK,
    context,
  )
}

describe('persistDenialState', () => {
  test('an async sub-agent keeps its own count, mutated in place', () => {
    const local = createDenialTrackingState()
    const context = { localDenialTracking: local } as unknown as ToolUseContext
    persistDenialState(context, { consecutiveDenials: 2, totalDenials: 5 })
    expect(local).toEqual({ consecutiveDenials: 2, totalDenials: 5 })
  })

  test('everyone else writes the store, and an unchanged state writes nothing', () => {
    const { context, denialTracking, state } = storeContext()
    const next = { consecutiveDenials: 1, totalDenials: 1 }
    persistDenialState(context, next)
    expect(denialTracking()).toBe(next)
    const before = state()
    persistDenialState(context, next)
    expect(state()).toBe(before)
  })
})

describe('handleDenialLimitExceeded', () => {
  test('below both limits it leaves the denial alone', () => {
    expect(limit({ consecutiveDenials: 1, totalDenials: 1 }, false)).toBeNull()
  })

  test('a streak asks the user, naming it and the latest block', () => {
    const decision = limit({ consecutiveDenials: DENIAL_LIMITS.maxConsecutive, totalDenials: 3 }, false)
    expect(decision?.behavior).toBe('ask')
    expect(decision?.decisionReason).toEqual({
      type: 'classifier',
      classifier: 'auto-mode',
      reason: `${DENIAL_LIMITS.maxConsecutive} consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: rm outside the repo`,
    })
  })

  test('the session total asks too, and starts the count over', () => {
    const store = storeContext()
    const decision = limit({ consecutiveDenials: 0, totalDenials: DENIAL_LIMITS.maxTotal }, false, store.context)
    expect(decision?.behavior).toBe('ask')
    expect(decision?.decisionReason).toMatchObject({
      reason: expect.stringContaining(`${DENIAL_LIMITS.maxTotal} actions were blocked this session.`),
    })
    expect(store.denialTracking()).toEqual({ consecutiveDenials: 0, totalDenials: 0 })
  })

  test('headless has no one to ask, so it aborts', () => {
    expect(() => limit({ consecutiveDenials: DENIAL_LIMITS.maxConsecutive, totalDenials: 3 }, true)).toThrow(AbortError)
  })
})

describe('classifierFallback', () => {
  test('a real block is not a fallback', () => {
    expect(classifierFallback({})).toBeNull()
  })

  test('a refusal asks the user, and headless keeps the denial', () => {
    expect(classifierFallback({ refused: true })).toEqual({
      cause: 'declined to assess this transcript',
      abortsHeadless: false,
    })
  })

  test('the permanent causes abort headless', () => {
    expect(classifierFallback({ transcriptTooLong: true })).toEqual({
      cause: 'transcript exceeded context window',
      abortsHeadless: true,
    })
    expect(classifierFallback({ deterministic: true })).toEqual({
      cause: 'request failed with a deterministic error',
      abortsHeadless: true,
    })
  })

  test('a timeout asks the user, and headless keeps its retry guidance', () => {
    expect(classifierFallback({ timedOut: true })).toEqual({
      cause: 'exceeded its time budget',
      abortsHeadless: false,
    })
  })
})

describe('decideClassifierBlock', () => {
  const MODEL = 'claude-sonnet-5-5'
  const REASON = 'Classifier declined to assess this transcript (stop_reason=refusal, 0 output tokens)'

  function block(
    flags: { refused?: boolean; timedOut?: boolean; unavailable?: boolean; transcriptTooLong?: boolean; deterministic?: boolean },
    { headless = false, denialState = createDenialTrackingState() } = {},
  ) {
    const store = storeContext()
    const decide = () =>
      decideClassifierBlock({
        classifierResult: { reason: REASON, model: MODEL, ...flags },
        ask: ASK,
        appState: { toolPermissionContext: { shouldAvoidPermissionPrompts: headless } },
        denialState,
        context: store.context,
        toolName: 'Bash',
      })
    return { decide, denialTracking: store.denialTracking }
  }

  test('a real block is a counted denial with the classifier reason', () => {
    const { decide, denialTracking } = block({})
    expect(decide()).toEqual({
      behavior: 'deny',
      decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: REASON },
      message: buildYoloRejectionMessage(REASON),
    })
    expect(denialTracking()).toEqual({ consecutiveDenials: 1, totalDenials: 1 })
  })

  test('a refusal asks the user, keeping the ask it stood in for, and counts nothing', () => {
    const { decide, denialTracking } = block({ refused: true })
    expect(decide()).toEqual({
      ...ASK,
      decisionReason: {
        type: 'other',
        reason: 'Auto mode classifier declined to assess this transcript — falling back to manual approval',
      },
    })
    expect(denialTracking()).toBeUndefined()
  })

  test('a timeout asks the user too', () => {
    const decision = block({ timedOut: true, unavailable: true }).decide()
    expect(decision.behavior).toBe('ask')
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: 'Auto mode classifier exceeded its time budget — falling back to manual approval',
    })
  })

  test('headless, a refusal takes the ordinary counted denial', () => {
    const { decide, denialTracking } = block({ refused: true }, { headless: true })
    expect(decide()).toMatchObject({ behavior: 'deny', decisionReason: { reason: REASON } })
    expect(denialTracking()).toEqual({ consecutiveDenials: 1, totalDenials: 1 })
  })

  test('headless, a timeout keeps its retry guidance and counts nothing', () => {
    const { decide, denialTracking } = block({ timedOut: true, unavailable: true }, { headless: true })
    expect(decide()).toEqual({
      behavior: 'deny',
      decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'Classifier unavailable' },
      message: buildClassifierUnavailableMessage('Bash', MODEL),
    })
    expect(denialTracking()).toBeUndefined()
  })

  test('an unavailable classifier fails closed, interactive or not', () => {
    expect(block({ unavailable: true }).decide()).toMatchObject({
      behavior: 'deny',
      decisionReason: { reason: 'Classifier unavailable' },
    })
  })

  test('headless, the permanent causes abort', () => {
    expect(block({ transcriptTooLong: true }, { headless: true }).decide).toThrow(AbortError)
    expect(block({ deterministic: true }, { headless: true }).decide).toThrow(
      'Agent aborted: auto mode classifier request failed with a deterministic error in headless mode',
    )
  })

  test('the block that reaches a limit asks the user to review, or aborts headless', () => {
    const denialState = { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: 2 }
    const decision = block({}, { denialState }).decide()
    expect(decision.behavior).toBe('ask')
    expect(decision.decisionReason).toMatchObject({
      type: 'classifier',
      reason: expect.stringContaining(`Latest blocked action: ${REASON}`),
    })
    expect(block({}, { denialState, headless: true }).decide).toThrow(
      'Agent aborted: too many classifier denials in headless mode',
    )
  })

  test('permissions.ts hands every block to it, with the ask it stood in for', () => {
    // The auto-mode branch is feature('TRANSCRIPT_CLASSIFIER'), false under
    // bun test, so the call is pinned on the source; what it decides is above.
    const src = readFileSync(join(import.meta.dir, '..', 'permissions.ts'), 'utf8')
    expect(src).toContain('if (classifierResult.shouldBlock) {')
    expect(src).toContain('return decideClassifierBlock({')
    expect(src).toContain('ask: result,')
  })
})
