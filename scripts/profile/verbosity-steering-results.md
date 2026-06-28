# Verbosity steering — A/B results (roadmap #4)

Feature: a length-ceiling steering block injected into the **dynamic** (post-boundary)
section of the system prompt, gated by `feature('VERBOSITY_STEERING')` and the runtime
resolver `isVerbositySteeringEnabled()`. Targets answer **length** — the axis the
`ANTI_NARRATION_HARNESS_BULLETS` deliberately do *not* cover (those kill preamble/narration,
not paragraph count), so it adds signal instead of restating "skip preamble".

Block text (`VERBOSITY_STEERING_SECTION` in `src/constants/prompts.ts`):

> Default to the shortest response that fully answers the question. Prefer a few sentences
> over multiple paragraphs, and a short list over a long one, unless the user asks for depth
> or the task genuinely needs it. Don't pad answers with restated context, caveats, or
> summaries of what the user can already see.

## Default & toggle

**Default-ON** at runtime. Opt out with `CLAUDIN_VERBOSITY_STEERING=0` (also `false`/`no`/`off`).
Mirrors the `TOOL_RESULT_JSON_COMPRESSION` precedent (`!isEnvDefinedFalsy(...)`).

## A/B method

`scripts/profile/cache-ab-bench.ts --workload=prose` — 7 repo-grounded explanation questions,
each with a verifiable core (a named file/function/flag the concise arm must still surface).
Same binary both arms; the ONLY difference is the env:

```
bun scripts/profile/cache-ab-bench.ts --a=claudindev --b=claudindev --workload=prose --runs=1 \
  --a-env=CLAUDIN_VERBOSITY_STEERING=0 --b-env=CLAUDIN_VERBOSITY_STEERING=1
```

The harness dumps each arm's final answer to `verbosity-ab-{A,B}.txt` for quality review and
reports two deltas: total output tokens (diluted by tool-call variance) and **final prose chars**
(the steering-specific signal).

## Result (runs=1, model=claude-sonnet-4-6)

| Metric | A (off) | B (on) | Δ |
|---|---|---|---|
| Final prose chars (steering signal) | 12.7k | 9.3k | **B 26.4% lower** |
| Total output tokens (incl. tool_use) | 9.6k | 7.6k | B 21.3% lower |

**Quality — no regression.** B answered all 7 questions and kept every verifiable core
(`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, the Bash output-filter file, the provider resolver,
`TOOL_RESULT_JSON_COMPRESSION`, the `feature()` build-time fold, `QueryEngine`/`query.ts`,
clip-frontier/`cache_control`). On the feature-flag question B was *more* specific (cited the
`featureImportRe`/`featureCallRe` regexes), so the shorter answer was not a vaguer one.

## Caveat

`runs=1` is noisy: an earlier single run showed only ~2% prose reduction vs the 26.4% here. The
**direction** is consistent (steering shortens answers without dropping content), but the
magnitude is not pinned down. A `runs=3+` median is recommended to firm up the headline number;
the opt-out env makes default-on low-risk in the meantime.
