import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

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

/*
 * The three request-count levers of 2026-09-24 (team memory
 * `request-count-levers-2026-09-24`). One request is one model response, and
 * calls in one response already share it, so each lever merges turns the
 * model spends in sequence. Each is an A/B arm and OFF until promoted: `=1`
 * adds its text, unset leaves every prompt byte-identical. Process-constant,
 * like the toggles above.
 *
 * All three are PARKED since 2026-09-25, off by the user's decision after the
 * session A/B `/tmp/session-cache-ab/20260925-035538` (N=5, Opus 5.5 medium;
 * transcripts under ~/.claudin/projects/-tmp-session-cache-ab-20260925-035538-*,
 * re-read with scripts/bench/ab/turn-taxonomy.ts). Each note below says what
 * it did and what would have to change before measuring it again.
 */

/**
 * `CLAUDIN_RESPONSE_CHAINS=1`: calls in one response run in the order written,
 * so an edit and the check that verifies it can share a response. It adds one
 * `# Harness` bullet (`RESPONSE_CHAINS_HARNESS_BULLET`), moves the git
 * protocol's read step into the last check's response (BashTool/prompt.ts),
 * and arms the guard that skips the tests, builds, shell and git commands
 * behind a failed call (agent/tools/responseChain.ts).
 *
 * Parked: the model barely changed — 17.2 API calls against 18.0, the same
 * number of test runs alone after a clean edit, and no git read moved into a
 * check's response. The guard fired once and no commit followed a failure.
 * Prompt text did not buy the chaining, so a retry needs a capability instead
 * of a sentence.
 */
export function isResponseChainsEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_RESPONSE_CHAINS)
}

/**
 * `CLAUDIN_ONE_PATCH_CHANGE=1`: the Anthropic addendum names a change's tests
 * and docs as part of its ONE Patch — the census found code, tests and README
 * patched in three calls over files already read.
 *
 * Parked: it worked and cost more. Split edits fell from 12 to 0 and API calls
 * 13% (15.2 against 17.5 over both arms that carried it), but the average
 * session cost 5–12% more: ~40% more thinking, and a big Patch whose hunk
 * missed was re-sent whole. Measure it again once a failed hunk can be fixed
 * without re-sending the patch.
 */
export function isOnePatchChangeEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_ONE_PATCH_CHANGE)
}

/**
 * `CLAUDIN_SUBAGENT_BATCHING=1`: one Notes line telling a fresh sub-agent that
 * independent calls share a response (`getSubagentBatchingNote` in
 * prompts.ts). Its prompt never carries the main thread's `# Harness`.
 *
 * Parked: inconclusive. On scripts/bench/ab/subagent-batching-ab.ts every arm
 * answered in 2–3 calls with one Bash loop, so the note had nothing to cut.
 * It needs a fixture whose base arm serializes, e.g. per-file facts that only
 * a Read shows.
 */
export function isSubagentBatchingEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_SUBAGENT_BATCHING)
}

/*
 * Round 2 of the request-count levers (2026-09-25), after the analysis of run
 * 20260925-035538 found where claudindev's extra calls against Claude Code go:
 * the commit and the orientation. Same shape as the three above — `=1` turns
 * it on, unset leaves every prompt byte-identical. PARKED after the session
 * A/B `/tmp/session-cache-ab/20260925-061930` (N=5, Opus 5.5 medium), like the
 * three above. Of its siblings, CLAUDIN_READ_GLOBS (FileReadTool/readGlobs.ts)
 * is parked too, and CLAUDIN_READONLY_GLOBS (BashTool/readOnlyValidation.ts)
 * was promoted.
 */

/**
 * `CLAUDIN_ONE_CALL_COMMIT=1`: the git protocol commits the session's own
 * changes in ONE Git call, which may share the response with the last edit or
 * check (BashTool/prompt.ts); only changes it did not make are read first. It
 * also arms the guard in agent/tools/responseChain.ts, which is what makes a
 * commit in the same response as an edit safe: a failed call before it skips it.
 *
 * Parked: 3 of 5 sessions committed in one call, and git-only calls fell from
 * 1.6 to 1.4 a session (Claude Code 0.4), but the arm spent 20.8 API calls
 * against 17.0 and cost 6.8% more — in edits and orientation the flag does not
 * touch, and the guard skipped nothing. With the two glob flags (the combo
 * arm) the session took 15.6 calls and cost 8.2% less, which the placebo
 * matched on calls (15.6, and 2.8% less). Measure it again at N≥10.
 */
export function isOneCallCommitEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_ONE_CALL_COMMIT)
}
