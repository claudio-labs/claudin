import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

// Runtime opt-out for the static steering block with enough mass in the
// cacheable prefix to be worth measuring: the WORK_CONTRACT sections (~885
// tokens across "# Delivering work", the act-on-what-you-know line and
// "# Corrections"). Default ON; `CLAUDIN_WORK_CONTRACT=0` (also false/no/off)
// subtracts them. The ANTI_NARRATION text and its `CLAUDIN_ANTI_NARRATION`
// twin were removed from every system prompt on 2026-09-23.
//
// WHY THESE EXIST. The build flags of the same name already gate this text,
// but `feature()` folds to a literal at build time, so reaching both arms of
// an A/B means building twice and comparing two bundles — the mistake that
// made the clip-pin A/B uncitable (see the header of
// scripts/bench/ab/lean-tool-prompts-ab.ts). Every other A/B in
// scripts/bench/ab/ flips ONE killswitch on ONE build; this is that killswitch
// for the steering lane, and `CLAUDIN_TOOL_PROMPT_TIER` in toolPromptTier.ts
// is the precedent.
//
// REACH: only where the matching `feature()` flag is on. With the flag off the
// text is compiled out and `=0` here is a no-op — the env can subtract the
// sections, never add them back.
//
// CACHE. Unlike CLAUDIN_VERBOSITY_STEERING, the blocks these gate live BEFORE
// SYSTEM_PROMPT_DYNAMIC_BOUNDARY, i.e. inside the cacheScope:'global' prefix.
// That is safe here only because an env var is constant for the life of the
// process: it yields two possible prefix texts across all runs rather than a
// bit that flips mid-session, and the default (unset) branch is byte-identical
// to what ships today. Do NOT extend this pattern to anything that can change
// while a session is running — that is the 2^N prefix-hash fragmentation the
// comment above getSessionSpecificGuidanceSection in prompts.ts is about.
//
// Pure env reads, no `feature()` gate, so they stay exercisable under the
// feature()-stubbed test preload.
export function isWorkContractEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_WORK_CONTRACT)
}

/**
 * The four sub-agent-only notes in `SUBAGENT_NOTES_BULLETS` (where a report
 * goes, who can authorize the agent, tool-result provenance, summarization) —
 * ~270 tokens on EVERY sub-agent request, which is what earns them a
 * killswitch. `CLAUDIN_SUBAGENT_NOTES=0` subtracts them.
 *
 * No `feature()` twin, unlike the two above: there is no build flag gating this
 * text, so the env var is the whole gate and the strings are always compiled
 * in. The sub-agent prompt is assembled per spawn and is not part of the
 * `cacheScope:'global'` prefix, so flipping this does not fragment it.
 */
export function isSubagentNotesEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_SUBAGENT_NOTES)
}

/**
 * The v2 system prompt: Claude Code 2.1.280's lean `-p` shape with every
 * Claudin capability kept (docs/tech/prompts/claude-code-2.1.280-reference.md,
 * pinned by promptFeatureCoverage.test.ts). The whole prompt, not one section,
 * moved thinking 30–50% in the transplant replays of 2026-09-23, so the v2 is
 * one switch. Anthropic family only — getSystemPrompt checks the family.
 *
 * Default ON since 2026-09-24, promoted by the user's decision: with the other
 * three v2 switches it takes the first request from 27.8k to 19.7k tokens,
 * and the session A/B found no cost change either way (team memory
 * `prompts-v2-2026-09`). `CLAUDIN_LEAN_SYSTEM_PROMPT=0` restores the previous
 * text; the killswitch is slated for removal in a cleanup pass. Same cache
 * reasoning as the toggles above: process-constant, so it yields two prefix
 * texts, never one that flips mid-session.
 */
export function isLeanSystemPromptEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_LEAN_SYSTEM_PROMPT)
}
