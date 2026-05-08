import type React from 'react'

/**
 * Pure reducer for the REPL's `toolJSX` slot.
 *
 * Background: the REPL renders at most one of two things in its overlay slot:
 *   - "regular" tool jsx (e.g. spinner / progress for an in-flight tool call)
 *   - a "local jsx command" (e.g. /provider, /model, /config modals — and any
 *     command marked `immediate: true`)
 *
 * Local jsx commands MUST NOT be overwritten by tool updates while open, and
 * conversely tools must not be blocked indefinitely if a stale local jsx
 * command write lands after the user has already moved on.
 *
 * The trickier invariant is the *async race*: in
 * `processUserInput/processSlashCommand.tsx` and `handlePromptSubmit.ts`, the
 * call site does `await load()` then `await mod.call()` then sets the
 * `isLocalJSXCommand: true` payload. If a *separate* code path issues a
 * `clearLocalJSX: true` between those awaits and the late set, the late set
 * used to "stick" — leaving `hasLocalJSXActive` permanently true and locking
 * the input queue (`useQueueProcessor` won't drain while a local jsx is
 * "active"). That's the slash-command-lockout bug.
 *
 * The fix: every clear bumps a monotonic `generation`. Async callers capture
 * the generation *before* they start awaiting, then echo it back when they
 * eventually call `set_local_jsx`. If the generation has been bumped in the
 * meantime, the late write is silently dropped.
 *
 * This module is intentionally pure (no React, no refs) so the invariant is
 * unit-testable. The REPL's `setToolJSX` callback is just a thin dispatcher.
 */

export type ToolJSXState = {
  jsx: React.ReactNode | null
  shouldHidePromptInput: boolean
  shouldContinueAnimation?: true
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  isImmediate?: boolean
} | null

export type ToolJSXAction =
  | { type: 'set_regular'; payload: NonNullable<ToolJSXState> }
  | {
      type: 'set_local_jsx'
      payload: NonNullable<ToolJSXState>
      generation: number
    }
  | { type: 'clear_local_jsx' }
  | { type: 'set_null' }

export type ReducerInternal = {
  state: ToolJSXState
  generation: number
  hasLocalJSXActive: boolean
}

export const initialReducerState: ReducerInternal = {
  state: null,
  generation: 0,
  hasLocalJSXActive: false,
}

export function applyToolJSXAction(
  prev: ReducerInternal,
  action: ToolJSXAction,
): ReducerInternal {
  switch (action.type) {
    case 'set_local_jsx': {
      // Drop stale writes: any caller whose captured generation is older
      // than the current one lost a race against a `clear_local_jsx`.
      if (action.generation < prev.generation) return prev
      // Bump on success too. This keeps `generation` strictly monotonic
      // across every local-jsx open/close, so a *third* stale write from an
      // even older chain (rare: rapid open → open without an intervening
      // clear) cannot satisfy the staleness check by accident.
      return {
        state: { ...action.payload, isLocalJSXCommand: true },
        generation: prev.generation + 1,
        hasLocalJSXActive: true,
      }
    }
    case 'clear_local_jsx': {
      return {
        state: null,
        generation: prev.generation + 1,
        hasLocalJSXActive: false,
      }
    }
    case 'set_regular': {
      if (prev.hasLocalJSXActive) return prev
      return { ...prev, state: action.payload }
    }
    case 'set_null': {
      if (prev.hasLocalJSXActive) return prev
      if (prev.state === null) return prev
      return { ...prev, state: null }
    }
  }
}
