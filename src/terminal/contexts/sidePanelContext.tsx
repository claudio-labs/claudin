import { createContext, useContext } from 'react'

/**
 * Keyboard focus arbitration between the chat prompt and a fullscreen side
 * panel (today only `/diff`, via a command's `fullscreenPanel`).
 *
 * Both halves are on screen at once, so exactly one of them may own the
 * keyboard. The panel is what switches: while it holds focus it registers a
 * modal overlay, which blanks `focus` on the prompt's `BaseTextInput` and with
 * it every keystroke (`BaseTextInput`'s `useInput(..., {isActive})`); while the
 * prompt holds focus the panel registers nothing and turns its own keybinding
 * context off, so the arrows reach the text input.
 *
 * REPL owns the state — it also owns `insertTextRef` and gates
 * `ScrollKeybindingHandler` on the same flag — and provides this above
 * `FullscreenLayout` so the prompt and the dialog both read it.
 *
 * null = no side panel is open (or we are not in fullscreen).
 */
export type SidePanelCtx = {
  /** A `fullscreenPanel` command is showing AND the terminal is wide enough to split. */
  open: boolean
  focus: 'panel' | 'prompt'
  setFocus: (focus: 'panel' | 'prompt') => void
  /**
   * Write an `@path#La-Lb` mention into the prompt. Goes through
   * `applyMention`, so adjusting the selection that produced it CORRECTS the
   * mention rather than stacking a second one — until the user types, after
   * which the line is theirs and the next call appends.
   */
  insertText: (mention: string) => void
}

export const SidePanelContext = createContext<SidePanelCtx | null>(null)

/** null when no side panel is open. */
export function useSidePanel(): SidePanelCtx | null {
  return useContext(SidePanelContext)
}

/**
 * Whether a component inside the panel currently owns the keyboard. True when
 * there is no side panel at all, so the takeover and inline paths keep today's
 * behavior without a special case at every call site.
 */
export function usePanelHasFocus(): boolean {
  const ctx = useContext(SidePanelContext)
  return ctx === null || ctx.focus === 'panel'
}
