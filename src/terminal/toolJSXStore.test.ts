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
  // The lease of a `fullscreenLayout` dialog goes back in the dispatch that
  // takes the dialog off screen — never earlier, or one main-screen frame
  // draws the dialog inline; never later, or the session stays in the alt
  // screen with nothing on it.
  describe('fullscreen lease', () => {
    const lease = () => {
      const state = { held: true, heldWhenStateLanded: [] as boolean[] }
      return { state, release: () => void (state.held = false) }
    }
    const open = (release?: () => void) =>
      dispatchToolJSX(
        {
          type: 'set_local_jsx',
          payload: localPayload('explorer'),
          generation: getCurrentLocalJSXGeneration(),
        },
        release,
      )

    test('is held while the dialog is up and released by the clear', () => {
      const l = lease()
      open(l.release)
      expect(l.state.held).toBe(true)
      dispatchToolJSX({ type: 'clear_local_jsx' })
      expect(l.state.held).toBe(false)
    })

    test('is released only after React has the cleared state', () => {
      const l = lease()
      bindToolJSXStore(() => l.state.heldWhenStateLanded.push(l.state.held))
      open(l.release)
      dispatchToolJSX({ type: 'clear_local_jsx' })
      // The clear's state reached React while the lease was still held: the
      // release follows in the same tick, so both land in one render.
      expect(l.state.heldWhenStateLanded).toEqual([true, true])
      expect(l.state.held).toBe(false)
    })

    test('a dialog replacing another hands the old lease back and keeps its own', () => {
      const first = lease()
      const second = lease()
      open(first.release)
      open(second.release)
      expect(first.state.held).toBe(false)
      expect(second.state.held).toBe(true)
    })

    test('a stale write that is dropped releases its lease at once', () => {
      const captured = getCurrentLocalJSXGeneration()
      dispatchToolJSX({ type: 'clear_local_jsx' })
      const l = lease()
      dispatchToolJSX(
        { type: 'set_local_jsx', payload: localPayload('late'), generation: captured },
        l.release,
      )
      expect(l.state.held).toBe(false)
    })

    test('tool updates while the dialog is up leave the lease alone', () => {
      const l = lease()
      open(l.release)
      dispatchToolJSX({ type: 'set_null' })
      expect(l.state.held).toBe(true)
    })
  })

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
