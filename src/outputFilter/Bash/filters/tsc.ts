// TypeScript compiler filter: tsc, tsc --noEmit, tsc --build.
//
// Modern tsc (5.0+) emits a `Errors  Files` summary table after the inline
// errors that duplicates the same count already on the "Found N errors in
// M files." line. We drop that table — N errors are still listed inline.
//
// We also strip ASCII underline `~~~~` lines under each error preview;
// the file:line:col on the diagnostic header carries the position already.
//
// On a clean run tsc emits empty stdout (no marker — handled upstream).
//
// Regex are declared at module level — see .claude/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

const TSC_MATCH = /^(?:npx\s+|yarn\s+|pnpm\s+|bunx\s+)?tsc\b/
// Passthrough for diagnostics modes whose verbose output IS the signal.
const TSC_PASSTHROUGH =
  /(?:^|\s)(?:--listFiles\b|--traceResolution\b|--diagnostics\b|--extendedDiagnostics\b|--watch\b|-w\b|--showConfig\b)/

// `~~~~~` (or with leading whitespace) under code preview — purely visual.
const TSC_STRIP_UNDERLINE = /^\s*~+\s*$/
// Trailing "Errors  Files\n" header + N rows of "    N  path:line".
// Use a single multi-line replace so we collapse the whole table to nothing.
const TSC_STRIP_ERRORS_TABLE_RE =
  /\n\nErrors\s+Files\s*\n(?:\s*\d+\s+\S[^\n]*\n?)+/g

export const tsc: FilterSpec = {
  name: 'tsc',
  matchCommand: TSC_MATCH,
  matchCommandReject: TSC_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [TSC_STRIP_UNDERLINE],
  replace: [{ pattern: TSC_STRIP_ERRORS_TABLE_RE, replacement: '' }],
}
