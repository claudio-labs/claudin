import { describe, expect, it } from 'bun:test'

import { isPromptTypingSuppressionActive } from 'src/agent/repl/replInputSuppression.js'

describe('isPromptTypingSuppressionActive', () => {
  it('suppresses dialogs while the user is mid-keystroke', () => {
    expect(isPromptTypingSuppressionActive(true, 'hello')).toBe(true)
  })

  it('stops suppressing once the typing timer disarms, even with a draft left in the prompt', () => {
    // Regression: this used to be `||`, so a leftover draft latched suppression
    // on forever. PROMPT_SUPPRESSION_MS sets the flag false ~1.5s after the last
    // keystroke; from that point a queued permission request must be drawn, or
    // the agent waits on an answer the user was never asked for.
    expect(isPromptTypingSuppressionActive(false, 'hello')).toBe(false)
    expect(isPromptTypingSuppressionActive(false, 'a')).toBe(false)
  })

  it('does not suppress dialogs for empty or whitespace-only input', () => {
    expect(isPromptTypingSuppressionActive(false, '')).toBe(false)
    expect(isPromptTypingSuppressionActive(false, '   ')).toBe(false)
  })

  it('does not suppress when the input was cleared behind a stale typing flag', () => {
    // Ctrl+U and submit clear the input without going through setInputValue, so
    // the flag can outlive the text it was armed for.
    expect(isPromptTypingSuppressionActive(true, '')).toBe(false)
    expect(isPromptTypingSuppressionActive(true, '   ')).toBe(false)
  })
})
