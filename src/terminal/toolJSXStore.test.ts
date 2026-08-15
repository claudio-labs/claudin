import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetToolJSXStoreForTests,
  bindToolJSXStore,
  dispatchToolJSX,
  getCurrentLocalJSXGeneration,
} from 'src/terminal/toolJSXStore.js'
import type { ToolJSXState } from 'src/terminal/setToolJSXReducer.js'

const localPayload = (label: string) => ({
  jsx: { type: 'mock', props: { label } } as unknown as React.ReactNode,
  shouldHidePromptInput: true as const,
})

afterEach(() => {
  __resetToolJSXStoreForTests()
})

describe('toolJSXStore', () => {
  test('bind forwards state changes to the external setter', () => {
    const seen: ToolJSXState[] = []
    bindToolJSXStore(s => seen.push(s))
    dispatchToolJSX({
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: getCurrentLocalJSXGeneration(),
    })
    expect(seen.length).toBe(1)
    expect(seen[0]?.isLocalJSXCommand).toBe(true)
  })

  test('full repro: late stale set after clear does not re-activate', () => {
    const seen: ToolJSXState[] = []
    bindToolJSXStore(s => seen.push(s))

    // 1. Caller A captures generation BEFORE awaiting.
    const capturedByA = getCurrentLocalJSXGeneration()

    // 2. Open succeeds (caller B, the one that actually wins).
    dispatchToolJSX({
      type: 'set_local_jsx',
      payload: localPayload('B'),
      generation: capturedByA,
    })
    expect(seen.at(-1)?.isLocalJSXCommand).toBe(true)

    // 3. External clear (e.g. start of new submission).
    dispatchToolJSX({ type: 'clear_local_jsx' })
    expect(seen.at(-1)).toBeNull()

    // 4. Caller A's microtask finally lands with the *captured* generation,
    //    which is now stale. The reducer must drop it.
    dispatchToolJSX({
      type: 'set_local_jsx',
      payload: localPayload('A-late'),
      generation: capturedByA,
    })

    // No new emission — the dispatcher short-circuits on identity.
    expect(seen.at(-1)).toBeNull()
  })

  test('rebind does NOT reset internal state (Strict Mode / HMR safety)', () => {
    bindToolJSXStore(() => {})
    dispatchToolJSX({
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: getCurrentLocalJSXGeneration(),
    })
    const genBeforeRebind = getCurrentLocalJSXGeneration()
    expect(genBeforeRebind).toBeGreaterThan(0)

    // Simulate React 18 Strict Mode dev double-invoke: cleanup then rebind.
    // If `bindToolJSXStore` reset internal state, generation would snap to 0
    // and `hasLocalJSXActive` would be lost — re-opening the original race.
    const cleanup = bindToolJSXStore(() => {})
    cleanup()
    bindToolJSXStore(() => {})

    expect(getCurrentLocalJSXGeneration()).toBe(genBeforeRebind)
  })

  test('cleanup only nulls external setter when identity matches', () => {
    let aCalls = 0
    let bCalls = 0
    const cleanupA = bindToolJSXStore(() => {
      aCalls++
    })
    bindToolJSXStore(() => {
      bCalls++
    })
    // A's cleanup fires AFTER B has bound — should be a no-op.
    cleanupA()

    dispatchToolJSX({
      type: 'set_local_jsx',
      payload: localPayload('provider'),
      generation: getCurrentLocalJSXGeneration(),
    })

    // B is still wired, A is not.
    expect(aCalls).toBe(0)
    expect(bCalls).toBe(1)
  })
})
