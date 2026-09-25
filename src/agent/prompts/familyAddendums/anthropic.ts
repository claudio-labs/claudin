import { feature } from 'bun:bundle'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isOnePatchChangeEnabled } from 'src/agent/prompts/steeringToggles.js'

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

// CLAUDIN_ONE_PATCH_CHANGE (off by default, steeringToggles.ts): the request
// census of 2026-09-24 found the code, then its tests, then the README
// patched in three calls over files already read, so the clause names them.
// Read once at module load, like the credit above; off, the text is
// byte-identical.
const ONE_PATCH_CHANGE = isOnePatchChangeEnabled()
const CHANGE_SCOPE = ONE_PATCH_CHANGE ? ', its tests and docs included,' : ','
const SPLIT_PATCH_ANTI_PATTERN = ONE_PATCH_CHANGE
  ? 'One patch per file, or code then tests then docs in separate calls,'
  : 'One patch per file'

export const ANTHROPIC_BATCHED_EDITS_ADDENDUM =
  `When a change touches several files${CHANGE_SCOPE} land it as ONE Patch call with a section per file, and Read every one of those files first in a single message${CAT_COUNTS_AS_READ}. ${SPLIT_PATCH_ANTI_PATTERN} is the anti-pattern here, not the careful option.`

export function getAnthropicAddendum(): string | null {
  return feature('TOOL_BATCHING_NUDGE') ? ANTHROPIC_BATCHED_EDITS_ADDENDUM : null
}
