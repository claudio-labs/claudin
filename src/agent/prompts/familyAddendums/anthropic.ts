import { feature } from 'bun:bundle'

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
export const ANTHROPIC_BATCHED_EDITS_ADDENDUM =
  `When a change touches several files, land it as ONE apply_patch with a section per file, and Read every one of those files first in a single message. One patch per file is the anti-pattern here, not the careful option.`

export function getAnthropicAddendum(): string | null {
  return feature('TOOL_BATCHING_NUDGE') ? ANTHROPIC_BATCHED_EDITS_ADDENDUM : null
}
