/**
 * Pure prefix-match: returns the remaining tail of `suggestionText` when
 * `inputValue` is a case-insensitive prefix; null otherwise. Extracted so it
 * can be unit-tested without spinning up the React/Ink runtime that
 * `usePromptSuggestion` depends on.
 */
export function computeGhostRemainder(
  suggestionText: string | null,
  inputValue: string,
  isAssistantResponding: boolean,
): string | null {
  if (isAssistantResponding || !suggestionText) return null
  if (!suggestionText.toLowerCase().startsWith(inputValue.toLowerCase())) {
    return null
  }
  return suggestionText.slice(inputValue.length)
}
