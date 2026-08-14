// Ruby toolchain filters — Phase 13 (rtk gap-fill).
//
//   - rake : tasks run arbitrary code, so this is deliberately conservative —
//     strip ANSI (minitest/rspec colour), collapse blank-line runs, and cap a
//     runaway task at maxLines. We never collapse to a sentinel and never strip
//     content lines, so a `rake aborted!` footer always survives. (A non-zero
//     exit already bypasses the filter upstream; this protects the rarer
//     "prints an error but exits 0" task.)
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from 'src/outputFilter/Bash/types.js'

const RAKE_MATCH = /^rake\b/
// `--trace` means the user explicitly wants the full backtrace — keep raw.
const RAKE_REJECT = /(?:^|\s)--trace\b/

export const rake: FilterSpec = {
  name: 'rake',
  matchCommand: RAKE_MATCH,
  matchCommandReject: RAKE_REJECT,
  stripAnsi: true,
  collapseRuns: true,
  maxLines: 80,
  truncateLineAt: 2000,
}
