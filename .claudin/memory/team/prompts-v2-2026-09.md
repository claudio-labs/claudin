---
name: prompts-v2-2026-09
description: Prompts v2 (branch perf/prompts-v2, 2026-09-24) — Claude Code 2.1.280's lean prompt shape with every claudin capability kept, behind four opt-in Anthropic-only switches; first request 27.8k → 19.7k tokens (CC 21.0k) but the session cost A/B FAILED its gate (thinking did not drop; the compact apply_patch text broke patches), so the switches stay OFF
type: project
---

**Goal, in the user's words (2026-09-24):** cut tokens and cost to near Claude Code *and keep
every claudin feature*. It follows round 3 ([[session-cost-round-3-2026-09-23]]), where the
transplant replays put the remaining thinking gap on the system prompt as a whole and the first
request was 28.4k tokens against Claude Code's 21.0k.

**On `perf/prompts-v2`** (branched from `perf/session-cost-round-3`, unpushed as of 2026-09-24):
- Anti-narration removed from every prompt (ea47c61a, [[anti-narration-never-benched-on-claude-5]]).
- Four switches, all default OFF, Anthropic family only — the whole family by the user's choice,
  though only Opus 5.5 was measured:

| switch | what changes | measured |
|---|---|---|
| `CLAUDIN_LEAN_SYSTEM_PROMPT` | CC's lean `-p` shape: batching in one sentence, turn discipline at ~⅓, only act-on-what-you-know of the work contract, scratchpad as one env line | system 18.1k → 13.3k chars, −1.4k tokens |
| `CLAUDIN_LEAN_MEMORY_PROMPT` | same mechanisms, fewer words | −2.6k chars, −0.8k tokens |
| `CLAUDIN_COMPACT_TOOL_PROMPTS` | Read, Grep, Agent, Bash, Build, Typecheck, RunTests at CC density; Monitor deferred. apply_patch was compacted too until a04426dc (below) | ~−13k chars of descriptions |
| `CLAUDIN_LEAN_REMINDERS` | git protocol reminder shorter, skill lines capped at 100 chars | messages[0] −1.8k chars |

- All four on: first request **27.8k → 19.7k tokens** (proxy, Opus 5.5), below CC. System +
  memory alone gave 25.6k, which missed the plan's interim ≤24.5k gate.
- The invariant is `src/agent/prompts/__tests__/promptFeatureCoverage.test.ts`: every capability
  marker stays in what the model reads, in the default and the v2 state. It now also pins
  apply_patch's four format rules (hunk order, one section per file, `@@` before changes,
  anchors copied not remembered).
- `docs/tech/prompts/claude-code-2.1.280-reference.md` holds the CC `-p` and interactive prompt
  the v2 text was extracted from; `systemPrompt.lean.txt` snapshots the shipped v2 dump.

**Session cost A/B, run `20260924-010251`** (proxy, N=5, Opus 5.5 effort high, all five arms
simultaneous; all 25 sessions 18/18 + one commit):

| median [min–max] | claude | claudindev | placebo | v2mem (sys+mem) | v2all (all four) |
|---|---|---|---|---|---|
| first-turn context | 21.0k | 27.8k | 27.8k | 25.6k | 19.7k |
| thinking (API) | 4.7k | 8.8k [7.1–11.3k] | 8.9k | 10.4k [8.7–14.8k] | 10.7k [6.2–13.4k] |
| turns | 18 | 21 | 21 | 21 | 25 |
| prefix, re-read every call | $0.163 | $0.191 | $0.191 | $0.164 | $0.151 |
| patch re-sent after a failure | 0 | 57 tok | 57 tok | 0 | 4.7k tok ($0.13) |
| **cost** | **$1.307** | **$1.408** | $1.428 | $1.432 (+2%) | $1.538 (+9%) |

- **The pre-registered cost gate fails for both v2 arms** (below claudindev with separated ranges;
  both overlap, both above). The placebo held (+1%). v2all also broke the turns guard (+19%).
  Per the plan, the switches stay OFF.
- **The prefix saving is real but small:** −$0.03 to −$0.04 a session, 2–3% — under the ~6%
  placebo noise floor, so no N=5 run can separate it. Prompt size is not a cost lever at this
  session length, the same verdict as [[read-shape-steering-is-cost-neutral]].
- **Thinking did not drop.** The replays' −28% with Claude Code's whole prompt did not carry over
  to the v2 prompt in full sessions: v2mem and v2all thought as much or more (overlap).
- **The compact apply_patch description broke patches:** 6 malformed patches in 5 v2all sessions,
  0 in the 10 on the full text (1 in v2mem, an ordinary dropped line). Hunks out of file order
  ("none of the N lines appear at or after line X"), a file in two sections, an Update with no
  `@@` — each re-sent whole. Fixed after the run (a04426dc): apply_patch keeps its full text.
- `delegation-steer-ab` N=3, all four on: every 09-23 gate passes — 7/7 correct (one miss in 21),
  0 forks, multi-hop delegation 0% → 20% (the ±20 pp edge), cost −3% SEPARATED.
- `read-strategy-ab` N=3, all four on, same build (`CLAUDIN_BENCH_FEATURE_ENV`): the gate passes —
  outline reads 37 → 35, whole-file reads 12% → 10%, answers 3/3 → 3/3. Cost +11% over the three
  runs (+29%, −5%, +7%), reads per run 41 → 47: noise at N=3, but not a saving either.

**The lever that did close the gap**, in both round-3 runs that tested it, is effort medium
($1.32 and $1.20 against CC's $1.22 and $1.27 in the same runs). It is a product decision, still
open.

**Traps met:**
- System-prompt prose runs ~3.3 chars/token, not the ~2.8 calibrated on schemas in
  [[request-prefix-size-2026-09-23]] — size a prose trim with 3.3.
- A never-sent prompt pays a full prefix cache write on its first run; see
  [[token-bench-measurement-traps]] before reading an N=1 smoke's prefix cost.
- A capability-marker test does not protect *format rules*: the compact apply_patch named every
  header and still lost the rules that keep a patch valid. Pin the rules a tool's failures depend
  on, not only its parameters.
- Locally, two `cacheProfile.test.ts` tests started failing mid-session while bench sessions ran
  on the real config; `CLAUDIN_CONFIG_DIR=<empty dir> bun test` gave 12,004/12,004 (the CI view).

**How to apply:** do not flip a v2 switch on the size win; re-open only with a hypothesis for
*thinking*, and a larger N or a placebo-matched design able to resolve a 3% effect. Any later
prompt edit keeps the coverage test green in both states.
