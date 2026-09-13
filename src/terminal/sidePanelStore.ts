import type React from 'react'
import type { CommandResultDisplay } from 'src/shared/types/command.js'
import type { Message } from 'src/shared/types/message.js'

/**
 * Module-level singleton holding the fullscreen SIDE PANEL (today only the
 * `/diff` reviewer).
 *
 * Why this is not the `toolJSX` slot it used to share: that slot holds exactly
 * one node, and `setToolJSXReducer` makes `set_regular`/`set_null` no-ops while
 * a local-jsx command is active. The panel is long-lived and the chat beside it
 * keeps running, so the turn needs that slot back — `!ls` renders its output
 * through it (`processBashCommand.tsx`) and `/model` would otherwise replace the
 * panel outright. A panel is also NOT a command result: it resolves nothing,
 * writes no transcript rows and must never hold the query guard.
 *
 * Why a singleton: `ctrl+g` opens the panel from `PromptInput`, which has no
 * access to REPL's state, and the command path opens it from an async `call()`
 * that shares no React tree. Same reasoning — and same shape — as
 * `toolJSXStore` and `messageQueueManager`. There is no `generation` counter
 * here: nothing awaits between the decision to open and the open itself.
 *
 * Why it holds a COMPONENT and not a node: REPL renders it with live props
 * (`messages`, `changeNonce`), which is what lets the panel follow the
 * conversation instead of freezing the snapshot it was opened with.
 */

export type SidePanelDoneOptions = { display?: CommandResultDisplay }

export type SidePanelProps = {
  /** Conversation so far. Re-snapshotted at each turn boundary, not per chunk. */
  messages: Message[]
  /**
   * Bumped when the working tree may have moved (a turn ended). The panel
   * re-reads git on a change and keeps the reader's place.
   */
  changeNonce: number
  /** Close the panel. Mirrors a local-jsx command's `onDone` so the same
   *  dialog works in both the panel and the inline/anchored arrangements. */
  onDone: (result?: string, options?: SidePanelDoneOptions) => void
}

export type SidePanelComponent = React.ComponentType<SidePanelProps>

export type SidePanelState = { Component: SidePanelComponent } | null

let state: SidePanelState = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Show `Component` in the side panel. Re-opening with the same component is a
 * no-op, so a second `ctrl+g` that races the first cannot remount the dialog
 * and throw away its state.
 */
export function openSidePanel(Component: SidePanelComponent): void {
  if (state?.Component === Component) return
  state = { Component }
  emit()
}

export function closeSidePanel(): void {
  if (state === null) return
  state = null
  emit()
}

export function subscribeSidePanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Identity is stable between changes — `useSyncExternalStore` requires it. */
export function getSidePanelSnapshot(): SidePanelState {
  return state
}

// Test-only.
export function __resetSidePanelStoreForTests(): void {
  state = null
  listeners.clear()
}
