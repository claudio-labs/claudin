import {
  applyToolJSXAction,
  initialReducerState,
  type ReducerInternal,
  type ToolJSXAction,
  type ToolJSXState,
} from 'src/terminal/setToolJSXReducer.js'

/**
 * Module-level singleton wrapping the toolJSX reducer.
 *
 * Why a singleton: the reducer's `generation` counter must be readable from
 * async call sites that don't share React tree (e.g.
 * `processUserInput/processSlashCommand.tsx`, `handlePromptSubmit.ts`).
 * Threading it through `ProcessUserInputContext` would force every command
 * call() signature to know about it. The codebase already uses the same
 * singleton pattern for `messageQueueManager`.
 *
 * The REPL binds itself once via `bindToolJSXStore(setExternalState)`. That
 * setter receives the freshly computed `ToolJSXState` after every dispatch.
 * Async callers capture the current generation via
 * `getCurrentLocalJSXGeneration()` *before* awaiting, then echo it back when
 * dispatching `set_local_jsx`.
 */

let internal: ReducerInternal = initialReducerState
let externalSetter: ((state: ToolJSXState) => void) | null = null
// The fullscreen lease of the local-jsx dialog on screen (a `fullscreenLayout`
// command, see processSlashCommand). Kept here rather than with the command
// because only this store knows when the dialog actually leaves the screen:
// handing it back from onDone released it a render early, and that render
// drew the dialog inline on the main screen for one frame.
let localJSXLease: (() => void) | null = null

export function bindToolJSXStore(
  setExternal: (state: ToolJSXState) => void,
): () => void {
  // Do NOT reset `internal` on bind/unbind: under React 18 Strict Mode the
  // effect runs bind → cleanup → bind in dev, and on HMR the REPL remounts.
  // Resetting would corrupt an in-flight local-jsx modal (e.g. `/provider`
  // open during a remount), losing `hasLocalJSXActive` and rewinding
  // `generation` to 0 — re-opening the same race the reducer was built to
  // close. Module-level lazy init is enough.
  externalSetter = setExternal
  return () => {
    if (externalSetter === setExternal) {
      externalSetter = null
    }
  }
}

/**
 * `fullscreenLease` rides a `set_local_jsx`: the store keeps it while that
 * dialog is on screen and calls it in the dispatch that takes the dialog off —
 * a clear, or another local jsx replacing it — AFTER the new state is handed
 * to React, so both land in the same render. A write that is dropped as stale
 * never shows its dialog, so its lease goes straight back.
 */
export function dispatchToolJSX(
  action: ToolJSXAction,
  fullscreenLease?: () => void,
): void {
  const next = applyToolJSXAction(internal, action)
  if (next === internal) {
    fullscreenLease?.()
    return
  }
  const leaving =
    internal.hasLocalJSXActive &&
    (action.type === 'set_local_jsx' || !next.hasLocalJSXActive)
  const release = leaving ? localJSXLease : null
  if (leaving) localJSXLease = null
  if (action.type === 'set_local_jsx') localJSXLease = fullscreenLease ?? null
  else fullscreenLease?.()
  internal = next
  externalSetter?.(next.state)
  release?.()
}

export function getCurrentLocalJSXGeneration(): number {
  return internal.generation
}

// Test-only: lets reducer-store integration tests reset state between cases.
export function __resetToolJSXStoreForTests(): void {
  internal = initialReducerState
  externalSetter = null
  localJSXLease = null
}
