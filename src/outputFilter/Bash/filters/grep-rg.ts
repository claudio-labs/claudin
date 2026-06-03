// grep / rg / ag / ack filter: shorten absolute file paths to their last
// few segments. Long paths from `grep -rn /abs/path` or `rg` run at repo
// root dominate the byte count without adding information.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// Match any of the four common code-search tools at the start of the command.
const GREP_MATCH = /^(?:grep|rg|ag|ack|ack-grep)\b/
// Passthrough modes where each output line is already compact / structured.
const GREP_PASSTHROUGH =
  /(?:^|\s)(?:-c|--count|-l|--files-with-matches|-L|--files-without-match|--json|--only-matching|-o)\b/

// Absolute-path collapser: capture the last three path segments and keep them.
//   /home/user/projects/repo/src/utils/errors.ts:42:foo
// → src/utils/errors.ts:42:foo
//
// The regex is anchored at line start, requires at least four path segments
// before the final one, and stops at the first `:` (grep/rg's file:line separator)
// or whitespace. The capture group `$1` is the last three segments joined
// by `/`, and we paste it back in place of the absolute prefix.
const GREP_ABS_PATH =
  /^\/(?:[^\s:/]+\/){2,}([^\s:/]+\/[^\s:/]+\/[^\s:/]+):/gm

export const grepRg: FilterSpec = {
  name: 'grep-rg',
  matchCommand: GREP_MATCH,
  matchCommandReject: GREP_PASSTHROUGH,
  replace: [
    {
      pattern: GREP_ABS_PATH,
      replacement: '$1:',
    },
  ],
}
