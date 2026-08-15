import { describe, expect, test } from 'bun:test'
import {
  applyToolJSXAction,
  initialReducerState,
  type ReducerInternal,
} from 'src/terminal/setToolJSXReducer.js'

const localPayload = (label: string) => ({
  jsx: { type: 'mock', props: { label } } as unknown as React.ReactNode,
  shouldHidePromptInput: true as const,
})

const regularPayload = (label: string) => ({
  jsx: { type: 'spinner', props: { label } } as unknown as React.ReactNode,
  shouldHidePromptInput: false as const,
})

describe('setToolJSXReducer', () => {
  test('R1: set_local_jsx populates state, marks active, and bumps generation', () => {
    const next = applyToolJSXAction(initialReducerState, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: 0,
    })
    expect(next.hasLocalJSXActive).toBe(true)
    expect(next.state?.isLocalJSXCommand).toBe(true)
    expect(next.generation).toBe(initialReducerState.generation + 1)
  })

  test('R2: clear_local_jsx clears state and bumps generation', () => {
    const opened = applyToolJSXAction(initialReducerState, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: 0,
    })
    const cleared = applyToolJSXAction(opened, { type: 'clear_local_jsx' })
    expect(cleared.state).toBeNull()
    expect(cleared.hasLocalJSXActive).toBe(false)
    expect(cleared.generation).toBe(opened.generation + 1)
  })

  test('R3 (regression): a stale set_local_jsx with old generation is dropped after a clear, even at non-zero starting generation', () => {
    // Mirror runtime: by the time the bug hits, several slash commands have
    // already cycled — generation is well above 0. Start at 7.
    const startingState: ReducerInternal = {
      state: null,
      generation: 7,
      hasLocalJSXActive: false,
    }

    // Caller A captures gen=7 and starts awaiting load() / mod.call().
    const capturedByA = startingState.generation

    // Meanwhile, a separate path (e.g. handlePromptSubmit at the start of a
    // new submission) clears the slot. Generation bumps to 8.
    const afterClear = applyToolJSXAction(startingState, {
      type: 'clear_local_jsx',
    })
    expect(afterClear.generation).toBe(8)

    // Caller A's microtask finally fires its late set with the captured gen=7.
    // It MUST be dropped — otherwise the input queue stays locked forever.
    const afterLateSet = applyToolJSXAction(afterClear, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: capturedByA,
    })
    expect(afterLateSet).toBe(afterClear) // identity preserved (no-op)
    expect(afterLateSet.state).toBeNull()
    expect(afterLateSet.hasLocalJSXActive).toBe(false)
  })

  test('R7 (regression): a stale set after a successful open-without-clear is also dropped', () => {
    // Rarer: caller A captures gen=0, caller B opens directly (no intervening
    // clear). A's late set must still lose, because set_local_jsx itself
    // bumps generation to keep the invariant strictly monotonic.
    const capturedByA = initialReducerState.generation
    const afterB = applyToolJSXAction(initialReducerState, {
      type: 'set_local_jsx',
      payload: localPayload('B'),
      generation: capturedByA,
    })
    // A second caller now captures gen=1 and dispatches successfully.
    const afterC = applyToolJSXAction(afterB, {
      type: 'set_local_jsx',
      payload: localPayload('C'),
      generation: afterB.generation,
    })
    expect(afterC.generation).toBe(afterB.generation + 1)
    // A's stale microtask finally lands. Without the success-bump it would
    // satisfy `gen >= prev.generation` once and clobber C's payload.
    const afterStaleA = applyToolJSXAction(afterC, {
      type: 'set_local_jsx',
      payload: localPayload('A'),
      generation: capturedByA,
    })
    expect(afterStaleA).toBe(afterC)
  })

  test('R4: set_regular is ignored while a local jsx command is active', () => {
    const opened = applyToolJSXAction(initialReducerState, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: 0,
    })
    const after = applyToolJSXAction(opened, {
      type: 'set_regular',
      payload: regularPayload('spinner'),
    })
    expect(after).toBe(opened)
    expect(after.state?.isLocalJSXCommand).toBe(true)
  })

  test('R5: set_null is ignored while a local jsx command is active', () => {
    const opened = applyToolJSXAction(initialReducerState, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: 0,
    })
    const after = applyToolJSXAction(opened, { type: 'set_null' })
    expect(after).toBe(opened)
    expect(after.hasLocalJSXActive).toBe(true)
  })

  test('R6: clear_local_jsx bumps generation even when nothing is active', () => {
    // This kills any in-flight stale set whose chain started before the clear.
    const after = applyToolJSXAction(initialReducerState, {
      type: 'clear_local_jsx',
    })
    expect(after.state).toBeNull()
    expect(after.hasLocalJSXActive).toBe(false)
    expect(after.generation).toBe(initialReducerState.generation + 1)
  })

  test('set_local_jsx with a future generation is accepted (caller captured a fresh token)', () => {
    const bumped: ReducerInternal = {
      state: null,
      generation: 5,
      hasLocalJSXActive: false,
    }
    const after = applyToolJSXAction(bumped, {
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: 5,
    })
    expect(after.hasLocalJSXActive).toBe(true)
    expect(after.generation).toBe(6)
  })

  test('set_regular when no local jsx active passes through', () => {
    const after = applyToolJSXAction(initialReducerState, {
      type: 'set_regular',
      payload: regularPayload('spinner'),
    })
    expect(after.state?.jsx).toBeDefined()
    expect(after.hasLocalJSXActive).toBe(false)
  })

  test('set_null when state already null is a no-op (identity preserved)', () => {
    const after = applyToolJSXAction(initialReducerState, { type: 'set_null' })
    expect(after).toBe(initialReducerState)
  })
})
