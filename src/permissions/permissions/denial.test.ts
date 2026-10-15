import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

import type { ToolUseContext, Tool } from 'src/tools/Tool.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
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
  handleDenialLimitExceeded,
  persistDenialState,
} from 'src/permissions/permissions/denial.js'

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
    {} as AssistantMessage,
    {} as Tool,
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

  test('the auto-mode branch asks it (source-pinned: that branch needs a live classifier)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'permissions.ts'), 'utf8')
    expect(src).toContain('const fallback = classifierFallback(classifierResult)')
    expect(src).toContain('if (fallback.abortsHeadless) {')
  })
})
