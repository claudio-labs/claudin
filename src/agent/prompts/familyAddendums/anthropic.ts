import { feature } from 'bun:bundle'
import { isEnvTruthy } from 'src/shared/envUtils.js'

// Anthropic family addendum.
//
// One clause: multi-file edits. It rides TOOL_BATCHING_NUDGE, the flag that
// owns the 1-file-per-turn round-trip waste. The anti-narration checkpoints
// that used to precede it were removed from every system prompt on
// 2026-09-23 by decision.
//
// Exported so the production wording can be snapshot-locked in tests: the
// flag-gated addendum resolves to null under the test preload (which stubs
// every feature flag to false).
//
// CLAUDIN_BASH_READ_CREDIT (off by default) makes a file a Bash `cat` printed
// whole count as read (BashTool/creditShownFiles.ts), so "Read every one of
// those files first" says so too — otherwise it sends the model back to Read
// what it was just shown. Read once at module load, like the credit itself.
const CAT_COUNTS_AS_READ = isEnvTruthy(process.env.CLAUDIN_BASH_READ_CREDIT)
  ? ' (files a `cat` already printed whole count as read)'
  : ''

export const ANTHROPIC_BATCHED_EDITS_ADDENDUM =
  `When a change touches several files, land it as ONE Patch call with a section per file, and Read every one of those files first in a single message${CAT_COUNTS_AS_READ}. One patch per file is the anti-pattern here, not the careful option.`

export function getAnthropicAddendum(): string | null {
  return feature('TOOL_BATCHING_NUDGE') ? ANTHROPIC_BATCHED_EDITS_ADDENDUM : null
}
