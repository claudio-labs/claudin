// Whether interrupt-style dialogs (tool permission, elicitation, cost, …) stay
// hidden because the user is mid-keystroke. `getFocusedInputDialog` returns
// `undefined` while this holds, so a queued request is simply not drawn.
//
// Suppression is bounded BY DESIGN: REPL.tsx arms `isPromptInputActive` on every
// keystroke and a PROMPT_SUPPRESSION_MS timer disarms it once typing stops.
// Both clauses must hold, and the reason is a real deadlock: this used to be an
// `||`, so any leftover draft in the prompt latched suppression on forever —
// the timer disarmed the flag, the text clause carried the suppression anyway,
// and every permission request queued afterwards waited on an answer the user
// was never asked for. Observed in the wild as three consecutive Bash calls
// stalling 383 s, 601 s and 569 s behind a spinner with no dialog on screen.
//
// The text clause survives as an AND-guard for the reverse skew: paths that
// clear the input without going through `setInputValue` (Ctrl+U, submit) leave
// the flag stale-true, and an empty prompt must never suppress.
export function isPromptTypingSuppressionActive(
  isPromptInputActive: boolean,
  inputValue: string,
): boolean {
  return isPromptInputActive && inputValue.trim().length > 0
}
