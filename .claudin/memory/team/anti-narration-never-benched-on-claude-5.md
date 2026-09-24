---
name: anti-narration-never-benched-on-claude-5
description: ANTI_NARRATION was REMOVED from every system prompt and family addendum on 2026-09-24 (perf/prompts-v2), by the user's decision after the session A/B's narr arm moved neither thinking nor cost; what it was, why it went, and what to measure if narration comes back
type: project
---

> **Removed 2026-09-24, commit `ea47c61a` on `perf/prompts-v2`.** The four harness bullets,
> the anthropic addendum's four checkpoints, and the narration / acknowledgement-opener lines
> of the glm, kimi, openai-reasoning and gemini addendums are gone, with the `ANTI_NARRATION`
> build flag and the `CLAUDIN_ANTI_NARRATION` toggle. The user's call, made while planning the
> prompts v2 rewrite ([[prompts-v2-2026-09]]).
>
> **The evidence it rode on.** The session A/B of 2026-09-23 (round 3,
> [[session-cost-round-3-2026-09-23]]) ran `narr` (`CLAUDIN_ANTI_NARRATION=0`) beside
> claudindev and a placebo, N=5: thinking 10.9k vs 10.7k, cost $1.54 vs $1.66, both inside the
> noise. The progress-updates bench (`narration-updates-ab.ts`, 18 runs) found updates rare with
> the text on or off. So on Claude 5 the text bought nothing measurable, and it was ~2.7k chars
> of the prompt weight the v2 rewrite trims.
>
> **What stays.** Tool-specific rules that happen to mention narration are not anti-narration:
> the Agent description's "emit the call instead of narrating it" (a launch announced without a
> tool call launched nothing) and the verbosity section's answer-length rule both stay.
> `promptFeatureCoverage.test.ts` and `prompts.test.ts` ("anti-narration is gone from every
> system prompt") pin the removal on every family's text.

**If narration comes back**, measure it on user-visible text between tool calls, not on
thinking: the counter the old benches used (`scripts/bench/results/narration-prompt-ab-claude-opus-4-8-*`,
Opus 4.8 only, before the text shipped) is the one to rebuild. Upstream Claude Code now
*mandates* narration in interactive mode ([[claude-code-2.1.270-prompt-diff]]); its `-p` path
carries neither rule.

**History.** `70bca79f` (2026-06-04) shipped it citing no measurement, as "intentional
reinforcement for Opus 4.7/4.8". The killswitches came with #77 (2026-08-12), whose own
work-contract A/B reported a null result. The per-Claude-5 tier question this file used to
track is moot with the text gone; `getModelFamily` still cannot tell Claude 4 from Claude 5
(`src/agent/prompts/familyAddendums/index.ts`), which matters to any future per-generation
prompt.
