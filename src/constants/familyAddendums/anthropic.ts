import { feature } from 'bun:bundle'

// Anthropic family addendum.
//
// The universal harness (src/constants/prompts.ts) already carries the
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

export const ANTHROPIC_ADDENDUM: string | null = feature('ANTI_NARRATION')
  ? ANTHROPIC_ANTI_NARRATION_ADDENDUM
  : null
