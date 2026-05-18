// Math helpers used by REPL components/hooks.
//
// Extracted from src/screens/REPL.tsx (Etapa 1, ROADMAP 11e) so REPL only
// imports what it actually needs. `median` is used for response-time
// statistics in the status bar.

/**
 * Integer median of a non-empty array of numbers. For even-length inputs
 * the average of the two midpoints is rounded to the nearest integer.
 *
 * Behaviour matches the original inline definition in REPL.tsx — empty
 * input produces `NaN` (sorted[mid]! reads `undefined`), which the caller
 * is expected to guard against.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!
}
