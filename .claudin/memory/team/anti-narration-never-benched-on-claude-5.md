---
name: anti-narration-never-benched-on-claude-5
description: ANTI_NARRATION was written for Opus 4.7/4.8; its first Claude 5 A/B (2026-09-23, progress updates) found overlap, so it stays; ModelFamily cannot express "Claude 5"
type: project
---

> **Benched on Claude 5, 2026-09-23 — for one question only.** Does ANTI_NARRATION suppress
> the progress updates Opus 5.5 / Fable 5.1 write under `display:"updates"`?
> `scripts/bench/ab/narration-updates-ab.ts` ran 18 graded runs, N=3 per arm per model. The
> arms were the default prompt, `CLAUDIN_ANTI_NARRATION=0`, and a carve-out sentence. The
> pre-registered range-overlap rule says **overlap → it stays**. The only updates came with it
> OFF, in 2 of 6 runs and one update each; the carve-out got 0 of 6. Interactive Claude Code
> got 0 (Opus 5.5) and 1 (Fable 5.1) on the same fixture, so updates are rare in both CLIs.
> A claim either way needs a larger N. Everything below about text narration and the
> work-contract still has no Claude 5 measurement. Results and method:
> `docs/tech/anthropic-betas/wire-matrix.md` ("Progress updates and ANTI_NARRATION").

Audited 2026-09-14.

**Provenance.** `70bca79f` (Thu Jun 4 2026), "feat(prompts): discourage tool-call narration by
default", states the WHY but cites **no measurement**, and says the overlap with the universal
layer is *"intentional reinforcement for Opus 4.7/4.8"* — repeated as a code comment at
`src/agent/prompts/familyAddendums/anthropic.ts:12`. The only narration benches on disk are
`scripts/bench/results/narration-prompt-ab-claude-opus-4-8-2026-05-30T*.md` (3 runs) and
`narration-effort-ab-claude-opus-4-8-*`, all dated **before** the commit. No `*-claude-opus-5-*`
or `*-sonnet-5-*` narration result exists. Killswitches were added later by `3c1e05dc`
(Wed Aug 12 2026, #77) alongside the work-contract A/B — whose own body reports a **null result**
(seven counters zero in both arms over eight sessions) and blames the task design.

**The blocker for a per-Claude-5 tier is the family type, not the prose.**
`getModelFamily` (`src/agent/prompts/familyAddendums/index.ts:62`) maps every `claude-*` id on
firstParty/bedrock/vertex to the single family `'anthropic'` — Claude 4 and Claude 5 are
indistinguishable at that layer, and `src/providers/model/` has no `isOpus5`-style predicate.
`LEAN_TOOL_PROMPTS` is a **tool-description** tier, not a system-prompt one:
`src/agent/prompts/toolPromptTier.ts:22-30` (`FAMILY_TIER`; lean = anthropic, openai-reasoning,
gemini, codex), live predicate `isLeanToolPromptFamily()` at `:57-61`, env override
`CLAUDIN_TOOL_PROMPT_TIER` at `:52-55`.

Prose layer is clean — `getSystemPrompt` (`prompts.ts:482-617`) is a filtered list of named
constants behind pure seams (`buildHarnessItems`, `buildWorkContractSections`,
`composeAnthropicAddendum`). Plumbing is not: `getHarnessSection()` (`:237`) and
`getAnthropicAddendum()` (`anthropic.ts:59`) take **no arguments**, and the `ADDENDUMS` record
thunks are `() => string|null` across 7 entries, so threading `model` through is a signature
change. Adding a `ModelFamily` member fails compilation until every tier table is updated
(deliberate exhaustiveness guard).

**Already-gated blocks** (so a Claude-5 experiment mostly needs env, not new gates):
ANTI_NARRATION bullets `prompts.ts:242`; the checkpoints addendum `anthropic.ts:59-68`
(already anthropic-family-only); `# Delivering work`/`# Corrections` `prompts.ts:607`
(`CLAUDIN_WORK_CONTRACT`); verbosity `prompts.ts:930-934` (`CLAUDIN_VERBOSITY_STEERING`);
scratchpad `:881-903`. **Unconditional:** `getTurnDisciplineSection` (`:260-264`, called `:601`).

**Harness to reuse: `scripts/bench/ab/work-contract-ab.ts`**, the precedent for A/B-ing two
*system prompts* — ONE build, one env killswitch, pinned model both arms, 7 pre-registered
behavioral counters plus `schemaErrors` as a validity gate, and it asserts the env actually
reaches the folded call site in `dist/` chunks (`:69-76`). Tokens are reported but explicitly
not the verdict. `cache-ab-bench.ts` is the WRONG tool — it A/Bs two CLIs on cache/cost.
`narration-prompt-ab.ts` uses two builds (`CLAUDIN_BENCH_BASELINE`/`_FEATURE`), the pattern the
repo now calls uncitable (`steeringToggles.ts:12-18`).

**Tests that pin the current shape** (a gate rewrite breaks them by design):
`prompts.test.ts:368-396` asserts the **literal source text** of the gate expressions;
`:66-67` pins the harness item count; `:188` pins exactly 4 bullets; `:98-110` pins the
addendum's carve-out and all four checkpoint markers; `__snapshots__/prompts.test.ts.snap`
locks the production wording. `work-contract-ab.test.ts` asserts the folded call-site string in
the built chunks. No `verify:*` script covers prompt content.

Team memory `prompt-tone-rewrite-unmeasurable.md` already concluded this class of change is
unmeasurable from logs and should be re-opened **only** with a graded A/B over a fixed task set.
Upstream's current position is in [[claude-code-2.1.270-prompt-diff]] — it now mandates narration.
