---
name: prompts-v2-2026-09
description: Prompts v2 (branch perf/prompts-v2) — Claude Code 2.1.280's lean prompt shape with every claudin capability kept; PROMOTED to default 2026-09-24 by the user's call although the cost gate failed; four `=0` killswitches remain and are slated for a cleanup pass (removal checklist inside)
type: project
---

**Goal, in the user's words (2026-09-24):** cut tokens and cost to near Claude Code *and keep
every claudin feature*. It follows round 3 ([[session-cost-round-3-2026-09-23]]), where the
transplant replays put the remaining thinking gap on the system prompt as a whole and the first
request was 28.4k tokens against Claude Code's 21.0k.

**Status: the v2 text is the DEFAULT since 2026-09-24** (Anthropic family only), promoted by the
user after the measurements below: the cost gate had failed, but the text is smaller and keeps
every capability (the coverage test proves it in both states), so the user chose to ship it and
keep the killswitches for a later cleanup. Anti-narration was removed from every prompt in the
same branch ([[anti-narration-never-benched-on-claude-5]]).

| killswitch (`=0` restores the pre-v2 text) | what the default now is |
|---|---|
| `CLAUDIN_LEAN_SYSTEM_PROMPT` | CC's lean shape: batching in one sentence, turn discipline at ~⅓, only act-on-what-you-know of the work contract, scratchpad as one env line |
| `CLAUDIN_LEAN_MEMORY_PROMPT` | the memory section with the same mechanisms in fewer words |
| `CLAUDIN_COMPACT_TOOL_PROMPTS` | Read, Grep, Agent, Bash, Build, Typecheck, RunTests at CC density; Monitor behind ToolSearch. apply_patch keeps its full text (its compact one broke patches, a04426dc) |
| `CLAUDIN_LEAN_REMINDERS` | skill listing lines capped at 100 chars. The git protocol attachment is NOT shortened: the compact git text dropped rules `BashTool/prompt.test.ts` pins ("if unclear, ask first", the review-comments endpoint, backslash escaping), so it was deleted at promotion and the round-2 lean git text stays |

- **First request, measured through the proxy at promotion** (same empty cwd, Opus 5.5, `-p`):
  claudin **19.9k** tokens (default) vs **27.2k** with all four `=0`; Claude Code **20.2k**.
- Byte-for-byte proof at promotion: the new default dump equals the v2 dump that was measured, and
  the all-`=0` dump equals the pre-promotion default (`systemPrompt.main.txt` /
  `systemPrompt.legacy.txt`).
- The invariant is `src/agent/prompts/__tests__/promptFeatureCoverage.test.ts`: every capability
  marker stays in what the model reads, in both states. It also pins apply_patch's four format
  rules (hunk order, one section per file, `@@` before changes, anchors copied not remembered).
- `docs/tech/prompts/claude-code-2.1.280-reference.md` holds the CC prompt the text came from.

**CLEANUP PASS — pending (the user asked for this to be recorded, 2026-09-24).** Delete the four
killswitches. The code is already marked ("slated for removal in a cleanup pass").

**Decide first:** every switch is Anthropic-family only, so the pre-v2 texts are still what
every OTHER provider receives (system prompt, memory, tool descriptions, skill lines). If other
families stay on them, the cleanup removes only the env-var reads and keeps the family gate; the
pre-v2 texts can be deleted only if other families move to the v2 text too — a separate call,
unmeasured outside Opus 5.5. Checklist:
- `src/agent/prompts/steeringToggles.ts` `isLeanSystemPromptEnabled` → delete, leaving
  `getFamilyForLogging(model) === 'anthropic'` in `getSystemPrompt`. Pre-v2 pieces that only the
  killswitch or other families reach: `getHarnessSection()`'s long batching bullet,
  `getTurnDisciplineSection()`, `buildWorkContractSections(true)` (Delivering work, Corrections),
  `getScratchpadInstructions()`, the long token-budget text, the non-lean session-guidance
  wordings. Check whether `CLAUDIN_WORK_CONTRACT` still gates anything afterwards.
- `src/memory/memdir/memdir.ts` `isLeanMemoryPromptEnabled` → delete, same family gate;
  `teamMemPrompts.ts` `buildCombinedMemoryPrompt` stays while other families use it (mind the
  extraction/dream prompts that share `memoryTypes.ts` renderers — only the system-prompt path
  switched).
- `src/agent/prompts/toolPromptTier.ts` `isCompactToolPromptsEnabled` / `isLeanRemindersEnabled`
  / `isV2PromptSwitchOn` → keep the family test, drop the env read. The compact descriptions live
  beside the full ones in Read, Grep, Agent, Bash, Build, Typecheck, RunTests;
  `ToolSearchTool/prompt.ts` (Monitor deferral) and `SkillTool/prompt.ts` (listing cap) read the
  same switches.
- Tests: `systemPrompt.legacy.txt` and the killswitched state in
  `systemPrompt.characterization.test.ts` / `promptFeatureCoverage.test.ts`; the killswitch cases
  in `steeringToggles.test.ts`; the probes in `scripts/migrations/probes/promptsV2.json` and
  `compactToolPrompts.json` that flip the switches.
- `scripts/bench/ab/*` variants that set these env vars (none committed; the 09-24 runs passed
  them on the command line).

**Session cost A/B before promotion, run `20260924-010251`** (proxy, N=5, Opus 5.5 effort high,
all five arms simultaneous; all 25 sessions 18/18 + one commit):

| median [min–max] | claude | claudindev | placebo | v2mem (sys+mem) | v2all (all four) |
|---|---|---|---|---|---|
| first-turn context | 21.0k | 27.8k | 27.8k | 25.6k | 19.7k |
| thinking (API) | 4.7k | 8.8k [7.1–11.3k] | 8.9k | 10.4k [8.7–14.8k] | 10.7k [6.2–13.4k] |
| turns | 18 | 21 | 21 | 21 | 25 |
| prefix, re-read every call | $0.163 | $0.191 | $0.191 | $0.164 | $0.151 |
| patch re-sent after a failure | 0 | 57 tok | 57 tok | 0 | 4.7k tok ($0.13) |
| **cost** | **$1.307** | **$1.408** | $1.428 | $1.432 (+2%) | $1.538 (+9%) |

- The pre-registered cost gate failed for both v2 arms (overlap, above claudindev); the placebo
  held (+1%). The v2all arm ran with the compact apply_patch and compact git texts, both since
  removed, so the promoted default was never measured as a whole session.
- The prefix saving is real but small: −$0.03 to −$0.04 a session, 2–3%, under the ~6% placebo
  noise floor. Prompt size is not a cost lever at this session length, the same verdict as
  [[read-shape-steering-is-cost-neutral]].
- Thinking did not drop: the replays' −28% with Claude Code's whole prompt did not carry over.
- The compact apply_patch description broke patches: 6 malformed patches in 5 v2all sessions, 0
  in the 10 on the full text — hunks out of file order, a file in two sections, an Update with no
  `@@`, each re-sent whole.
- `delegation-steer-ab` N=3: every 09-23 gate passes (7/7 correct, 0 forks, cost −3% SEPARATED).
- `read-strategy-ab` N=3: gate passes (outline 37 → 35, whole-file 12% → 10%, answers 3/3);
  cost +11% over three runs (+29/−5/+7%), noise at N=3.

**The lever that did close the gap**, in both round-3 runs that tested it, is effort medium
($1.32 and $1.20 against CC's $1.22 and $1.27 in the same runs). It became the Opus 5.5 default on
2026-09-24, on this branch ([[opus-5-5-default-effort-medium]]).

**Traps met:**
- System-prompt prose runs ~3.3 chars/token, not the ~2.8 calibrated on schemas in
  [[request-prefix-size-2026-09-23]] — size a prose trim with 3.3.
- A never-sent prompt pays a full prefix cache write on its first run; see
  [[token-bench-measurement-traps]] before reading an N=1 smoke's prefix cost.
- A capability-marker test does not protect *format rules* or rule wording: the compact apply_patch
  named every header and lost the rules that keep a patch valid, and the compact git text passed
  the coverage markers but failed the BashTool rule tests. Run the owning tool's own rule tests
  against any compact text before promoting it.
- Locally, two `cacheProfile.test.ts` tests fail while bench sessions have touched the real config;
  `CLAUDIN_CONFIG_DIR=<empty dir> bun test` is the CI view (12,005/12,005 at promotion).

**How to apply:** treat the four killswitches as dead weight to delete in the cleanup above, not
as A/B levers; any prompt edit keeps the coverage test green. Re-opening "why does claudin think
more than CC" needs a hypothesis for *thinking*, not prompt size.
