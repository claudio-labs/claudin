import { feature } from 'bun:bundle'
import { isAntiNarrationEnabled } from 'src/agent/prompts/steeringToggles.js'

// Anthropic family addendum.
//
// The universal harness (src/agent/prompts/prompts.ts) already carries the
// transcript-shape invariant (gated on feature('ANTI_NARRATION')). This
// addendum stacks the Opus-specific behavioral contract on top: explicit
// numbered checkpoints, a selection rule for the final summary (what
// changes the reader's next action — not a fixed bullet count), and a
// failures-first carve-out. The overlap with the universal bullets is
// intentional — Opus 4.7/4.8 latch onto numbered-invariant framings far
// longer than negative-only bullet lists, so restating the rule as
// checkpoints reinforces it for Anthropic models without changing what
// non-Anthropic providers see.
//
// A second, independent clause covers multi-file edits. It is gated on
// TOOL_BATCHING_NUDGE rather than ANTI_NARRATION on purpose: that flag already
// owns the 1-file-per-turn round-trip waste, and putting an edit-batching
// sentence behind the narration kill switch would confound both A/B benches.
//
// Gated on the same flag as the universal bullets so flipping
// ANTI_NARRATION=false fully restores the prior behavior (kill switch for
// A/B benches; see scripts/build.ts:70).
//
// If this proves too aggressive in practice, soften the wording in place
// rather than reverting to null — the default Claudin install should
// discourage narration without the user having to know about it.
// Exported so the production wording can be snapshot-locked in tests — the
// flag-gated `ANTHROPIC_ADDENDUM` below resolves to null under the test
// preload (which stubs every feature flag to false), so tests can't reach
// the live string through the addendum itself.
export const ANTHROPIC_ANTI_NARRATION_ADDENDUM =
  `Failures and unexpected results are reported immediately and succinctly; everything else waits for the summary. Speak only at four checkpoints: (1) task complete — lead with outcome, then \`file:line — what changed\` bullets selected for what changes the reader's next action, not an exhaustive list; (2) blocked and need a decision; (3) about to do something destructive — confirm first; (4) the user asked a question requiring a prose answer. Plan-mode output (EnterPlanMode/ExitPlanMode plans) is the deliverable, not narration — the checkpoint summary rules do not apply there.`

// Exported for the same snapshot reason as the constant above.
export const ANTHROPIC_BATCHED_EDITS_ADDENDUM =
  `When a change touches several files, land it as ONE apply_patch with a section per file, and Read every one of those files first in a single message. One patch per file is the anti-pattern here, not the careful option.`

/**
 * Exported so the composition is testable: under the test preload every
 * feature flag is false, so `ANTHROPIC_ADDENDUM` is always null there and the
 * join / null-when-empty behavior would otherwise never be exercised.
 */
export function composeAnthropicAddendum(
  parts: ReadonlyArray<string | null>,
): string | null {
  const kept = parts.filter((part): part is string => part !== null)
  return kept.length > 0 ? kept.join('\n\n') : null
}

/**
 * Resolved per call rather than at module eval so the `CLAUDIN_ANTI_NARRATION`
 * killswitch is readable by tests (a module-level const would freeze the env
 * as it stood at import time). The two clauses stay on separate gates: the
 * narration half rides ANTI_NARRATION and its env twin, the batching half
 * rides TOOL_BATCHING_NUDGE alone, so an A/B on one does not move the other.
 */
export function getAnthropicAddendum(): string | null {
  const antiNarrationPart = feature('ANTI_NARRATION')
    ? isAntiNarrationEnabled()
      ? ANTHROPIC_ANTI_NARRATION_ADDENDUM
      : null
    : null
  const batchedEditsPart = feature('TOOL_BATCHING_NUDGE')
    ? ANTHROPIC_BATCHED_EDITS_ADDENDUM
    : null
  return composeAnthropicAddendum([antiNarrationPart, batchedEditsPart])
}
