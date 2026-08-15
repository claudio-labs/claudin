import {
  applyToolJSXAction,
  initialReducerState,
  type ReducerInternal,
  type ToolJSXAction,
  type ToolJSXState,
} from 'src/utils/setToolJSXReducer.js'

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

export function dispatchToolJSX(action: ToolJSXAction): void {
  const next = applyToolJSXAction(internal, action)
  if (next === internal) return
  internal = next
  externalSetter?.(next.state)
}

export function getCurrentLocalJSXGeneration(): number {
  return internal.generation
}

// Test-only: lets reducer-store integration tests reset state between cases.
export function __resetToolJSXStoreForTests(): void {
  internal = initialReducerState
  externalSetter = null
}
