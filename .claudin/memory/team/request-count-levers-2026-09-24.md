---
name: request-count-levers-2026-09-24
description: The "fewer API requests per session" work (2026-09-24/25, branches perf/request-count-levers and perf/request-count-round-4), four A/B rounds — where requests go (bench + real corpus census); chains, one Patch, one-call commit (N=10, no), Read globs and Grep bodies PARKED off; read-only path globs PROMOTED (#249); round 4's Patch/Edit `then` and path-keeping cap PROMOTED 2026-09-25 (#250); the sub-agent audit bench and its validity gate; plus the harness facts the trace found
type: project
paths:
  - "src/agent/tools/StreamingToolExecutor.ts"
  - "src/agent/tools/toolOrchestration.ts"
  - "src/agent/tools/responseChain.ts"
  - "src/agent/prompts/steeringToggles.ts"
  - "src/tools/FileReadTool/readGlobs.ts"
  - "src/tools/shared/editThen/*.ts"
  - "src/tools/GrepTool/grepBodies.ts"
  - "src/tools/shared/outputFilter/Bash/floor.ts"
  - "scripts/bench/ab/subagent-audit-ab.ts"
---

**Context.** Once the batch Read tied Claude Code on API calls (17 each, run
`-231111`, [[cat-read-and-batch-read-ab-2026-09-24]]), the user asked for more
levers of that kind. One request = one model response, and calls in one response
already share it, so only merging *sequential* turns saves anything. Plan:
`.claudin/plans/synchronous-conjuring-creek.md` (local).

**Where the requests go.** Both tools are committed:
`scripts/bench/ab/turn-taxonomy.ts <stamp> <arms>` for a bench run, and
`scripts/bench/tokens/request-census.ts --since=<date>` for the real corpus.
- Bench `-231111`: claudindev spent its extra calls on reads, a test run alone
  after a clean edit (8 in 5 reps), a separate git read before the commit (3,
  Claude Code 0), and code → tests → README patched in separate calls.
- Real corpus (09-14..24, 14.2k main calls, **11.7k in sub-agents = 45%**):
  - 74% of main calls carry one tool call (62% in sub-agents);
  - "core" mergeable union 18%;
  - chains 10.6% of main calls, but only 4.0% on Opus 5.5;
  - paging a file already read 8.1%, which is dependent reading;
  - ToolSearch-only calls 0.5%, Task-only calls 2%.

**The A/B.** Run `/tmp/session-cache-ab/20260925-035538`, 7 simultaneous arms,
N=5, all 35 sessions 18/18 with one commit. Transcripts survive in
`~/.claudin/projects/-tmp-session-cache-ab-20260925-035538-*`.

| mean per session | calls | cost |
|---|---|---|
| claude | 16.4 | $1.007 |
| claudindev | 18.0 | $1.023 |
| placebo | 17.4 | $1.051 |
| chain | 17.2 | $1.051 |
| onepatch | 15.0 | $1.142 |
| chain+onepatch | 15.4 | $1.077 |
| auto | 18.2 | $1.017, plus $0.10 of classifier |

- **Chains** (`CLAUDIN_RESPONSE_CHAINS`): no effect.
  - It adds a harness sentence, moves the git read into the last check's
    response, and a guard in `runTools` skips tests, builds, Bash and Git after
    a failed call (`responseChain.ts`, Bash `reducedExitCode`).
  - The model barely changed: 3 edit+check responses per session vs 2, and the
    git read still took a call of its own.
  - The guard fired once and no commit followed a failure.
- **One Patch per change** (`CLAUDIN_ONE_PATCH_CHANGE`): the mechanism worked
  (split edits 12 → 0, edit turns 8 → 3) and cut calls 13%.
  - But cost rose 5–12%: ~40% more thinking, and a big Patch whose hunk missed
    was re-sent whole (rep 3: $1.355).
  - Wall time rose 12%.
  - The user asked "mais barato ou mais caro?" and parked it.
- **Sub-agent note** (`CLAUDIN_SUBAGENT_BATCHING`): inconclusive. The Code agent
  answered `subagent-batching-ab.ts` in 2–3 calls with one Bash loop in every arm.
- **Auto-mode classifier**:
  - 3 [2–4] requests per session, $0.104 (~10% on top);
  - zero responses with 2+ judged actions and zero repeated actions, so
    batching or caching the classifier saves nothing here;
  - its cost is per request (~$0.035, transcript uncached).
- **Proof**:
  - `scripts/bench/ab/response-chain-e2e.ts` (mock model, 38 checks);
  - `scripts/migrations/probes/responseChain.json` (56 probes, all red);
  - `src/agent/tools/toolOrchestration.test.ts`, the first test of `runTools`
    itself.

**Round 2 (2026-09-25): four candidates from the analysis of that run.**
claudindev followed the 2-call git protocol literally (1.4 git-only calls a
session, Claude Code 0.6), oriented in 3 calls where Claude Code's first is
`git ls-files && cat src/*.ts`, ran /pre-pr as ~8 calls, and sent every auto
session's first call to the classifier for its glob. Run
`/tmp/session-cache-ab/20260925-061930`, 8 simultaneous arms, N=5, all 40
sessions 18/18 with one commit.

| mean per session | calls | cost | vs claudindev |
|---|---|---|---|
| claude | 15.0 | $0.962 | −9.1% |
| claudindev | 17.0 | $1.059 | — |
| placebo | 15.6 | $1.029 | −2.8% |
| commit1 | 20.8 | $1.130 | +6.8% |
| readglobs | 17.2 | $1.056 | −0.3% |
| combo (all three flags) | 15.6 | $0.972 | −8.2% |
| autobase / autocombo | 18.0 / 18.2 | $1.048 / $1.116 | classifier 20 → 11 requests |

- **One-call commit** (`CLAUDIN_ONE_CALL_COMMIT`, PARKED): 3/5 sessions
  committed in one call and git-only calls went 1.6 → 1.4 (Claude Code 0.4).
  The arm's extra calls were edits and orientation, and the guard skipped
  nothing.
- **Globs in the Read** (`CLAUDIN_READ_GLOBS`, PARKED): used in 5/5 sessions
  (2.2 glob Reads of ~26 files, none past the budget), but each session first
  listed the tree with Glob, and the first edit came later (turn 3.6 vs 2.8).
- **Read-only path globs** (`CLAUDIN_READONLY_GLOBS`): PROMOTED, on by default,
  see [[readonly-path-globs-default-on]].
- **/pre-pr** (no flag): the checks after the build go out in one response, so
  the skill takes 2 requests instead of ~8.
- **combo −8.2%** is the cheapest claudin arm yet, but its range overlaps
  claudindev's and placebo's, and its calls equal the placebo's: at N=5, not an
  effect.
- **The E2E found** that ripgrep's `--glob` overrides `.gitignore` for the files
  it matches (ignored directories are still skipped), so a glob Read listed an
  ignored file. `glob.ts` filters the listing after the walk when
  `respectGitignore` is set.
- **Bench trap:** a base arm now has read-only globs on; pass
  `CLAUDIN_READONLY_GLOBS=0` to measure the old verdict.
- **Proof:** `read-credit-e2e.ts` (43 checks), `response-chain-e2e.ts` (74), and
  `scripts/migrations/probes/requestLevers2.json` (134 probes, all red).

**How to resume.** The notes in `steeringToggles.ts` and `readGlobs.ts` say what
each parked lever needs first:
- chains: a capability rather than a sentence;
- one Patch: a hunk miss that can be fixed without re-sending the patch;
- the sub-agent note: a fixture whose base arm serializes;
- the one-call commit: a rerun at N≥10, since its arm's noise hid the effect;
- Read globs: a first call that can be the glob Read, e.g. with the project's
  file list already in context.

Across both rounds, prompt text moved no call count, which matches
[[tool-result-nudges-benched-zero-adoption]]. The batch Read cut calls because
it merged Reads the model already made; the glob Read did not, because the
model still listed the tree before reading. What separates claudin's
orientation from Claude Code's is the first call: Claude Code reads files it
has not seen listed.

**Round 3 (2026-09-25, main @71f12a8a, run `/tmp/session-cache-ab/20260925-135901`,
5 simultaneous arms, N=5, all 25 sessions 18/18 + one commit, ~$28).**

| per session | claude | claudindev | placebo | nocap | commit1 |
|---|---|---|---|---|---|
| calls, mean | 15.2 | 16.4 | 19.6 | 21.0 | 19.4 |
| cost, median | $0.969 | $1.065 | $1.051 | $1.244 | $1.223 |

- **Noise:** claudindev and placebo are the same build and differ by 3.2 calls
  (medians 17 vs 22). Judge an N=5 arm by its mechanism, never by total calls.
- **The gap, pooled over the three runs** (-035538, -061930, -135901; claude
  N=15, claudindev+placebo N=30): 15.5 vs 17.3 calls (+12%).
  - Phase 1 is equal (8–10 both).
  - The gap is all in phase 2: git-only calls 0.47 vs 1.63, and a test run in
    its own call after an edit (Claude Code chains `&& bun test` into the
    edit).
- **commit1, now N=10:** the separate git read went to 0 and git-only calls to
  1.3, but calls were 20.1 against the base's 17.3, and the first edit came one
  call later in both runs (4.2 and 4.4 against 2.8–3.4). The cause is not
  known. The N≥10 condition is met and the verdict is no.
- **The Bash cap hides the orientation listing** (`floor.ts`, 60 lines → 15+15).
  `git ls-files && cat README.md package.json && wc -l …` prints ~143 lines.
  The cut middle holds `src/regions.ts` in every capped session: 56 of 58
  Bash-first sessions in -035538 and -061930, and 7 in -135901. In 43 of the
  80 capped sessions a hidden file was read later (calls 3–6). Sometimes the
  model re-ran `git ls-files | tail -n +15` first.
- **nocap** (`CLAUDIN_DISABLE_BASH_FILTER_CAP=1`):
  - Mechanism: 0 late reads and 0 refetches.
  - It is still not a lever: README.md now arrived whole from `cat` and was
    never Read, so its Patch hit the read gate 4 times (then `*** Resubmit`).
    Output rose 24% and cost 17% against claudindev.
  - The cap and the read gate are coupled. A fix has to keep the path lines in
    the cut and cap the rest.
- **Real corpus since 09-24** (`request-census.ts --since=2026-09-24`, 5,797
  calls):
  - Sub-agents make **60%** of the calls: 3,497, all Code/fork, median 64
    calls a thread, 69% one-tool, 77% ORIENT.
  - The session bench makes 0 sub-agent calls, so it cannot see any of this.
  - The batch Read was 41 of 2,491 Reads.
  - In the claudin repo, 386 of 6,488 Bash-bearing calls were capped (09-14..25).
    After a capped result, the next call re-ran the same command 18.7% of the
    time (8.2% after an uncapped one) and Read a path the command named 13.2%
    of the time (7.5%). That is ~60 extra calls in 12 days, ~0.2% of calls.
- All three candidates were built in round 4, below.

**Round 4 (2026-09-25, branch `perf/request-count-round-4`, plan
`.claudin/plans/harmonic-wobbling-clock.md`).** Three levers as tool
capabilities, not prompt text, each behind a flag that is off by default:
- **`then`** on Patch/Edit (`CLAUDIN_EDIT_THEN`, `src/tools/shared/editThen/`):
  1–3 commands run through BashTool's own call once the edit applies, stopping
  at the first failure, with the output in the edit's result. It runs only
  where no dialog would open (bypass, auto) and no Pre/PostToolUse hook is
  configured. Elsewhere the edit applies and its result says why the commands
  did not run. (The plan had validateInput refuse instead, but that costs the
  round-trip the lever exists to save.) A red `then` arms the response-chain
  guard.
- **Path-keeping cap** (`CLAUDIN_CAP_KEEP_PATHS`, `floor.ts` `keepLines`):
  the 15+15 cut spares up to 200 path-shaped lines (a bare path, or a
  `wc -l`/`du` count and path) in place.
- **Grep bodies** (`CLAUDIN_GREP_BODIES`, `GrepTool/grepBodies.ts`):
  `bodies: true` in symbols mode returns each matched symbol whole and
  registers it as a served region (12k budget, bypasses the summarizer).

Session run `/tmp/session-cache-ab/20260925-153340`: 6 simultaneous arms,
N=8, all 48 sessions 18/18 with one commit, **$79** (estimated $52).

| per session | claude | claudindev | placebo | then | pathcap | grepbody |
|---|---|---|---|---|---|---|
| calls, mean | 14.8 | 18.1 | 18.3 | **15.5** | 17.4 | 18.6 |
| cost, median | $1.004 | $1.064 | $0.977 | $0.985 | $1.049 | $0.984 |

- **then passed all five pre-registered gates.**
  - Used in 8/8 sessions (2.5 edits a session).
  - Test run alone after a clean edit: 4 vs 9.
  - Calls below base and placebo (−14%).
  - Cost −7% (at placebo's level).
  - 18/18 everywhere; no red `then` and no dropped one.
  - It closes most of the gap to Claude Code: +5% calls, from +23%.
  - Live check from a throwaway cwd: the model put `bun test` in `then` on
    its first Patch, unprompted.
- **pathcap passed on mechanism**, the promotion path the plan allowed.
  - 4/8 first listings were capped and all 4 kept every `src/` path; every
    capped listing in the other arms hid some.
  - Late reads of a hidden file: 0/8 vs base 5/8 and placebo 6/8.
  - First edit at call 2.8 vs 3.9/4.5; cost −1%; result chars +2%.
  - The "read-gate refusals ≤ base" gate nominally failed, 2 vs 0. Both come
    from one session (r4) where the first command exited non-zero, so the
    filter, and the cap with it, never ran; the refusals are the
    `cat`-doesn't-count read gate on README.md and src/types.ts.
- **Both PROMOTED 2026-09-25** by the user (default on, `=0` killswitch;
  [[edit-then-and-cap-keep-paths-default-on]]). then's cost win sits inside
  the placebo band; its call win does not.
- **grepbody: PARKED, never engaged** (0/8 here, 0/5 in the sub-agent round).
  The models search in `content` mode (`export function (a|b|c)\b`) and never
  in `symbols`. To retry, make `bodies` answer the mode they use.

**Sub-agent bench** (`scripts/bench/ab/subagent-audit-ab.ts` +
`subagentAuditFixture.ts`). The first fixture (who calls ten functions)
failed its own validity gate: Opus answered in three alternation Greps (4
calls). It is now a call-chain trace:
- 720 functions in 16.6k lines;
- each body hides its one cross-module call among `acc = helperBits(acc, N)`
  lines of the same shape, often under an alias or an index.ts rename;
- 3 chains of 7, 21 points.

The base child takes 16 calls, mostly single-tool. It folds find + read on its
own: a shell function per hop prints the imports, the definition line and the
body minus helpers.

Run `/tmp/subagent-audit-ab/20260925-153340`, N=5, $7.45:

| child, median | calls | cost |
|---|---|---|
| base | 16 | $0.258 |
| placebo | 17 | $0.381 |
| batching | 13 | $0.215 |
| grepbody | 17 | $0.254 |

- `batching` is the best arm but fails its gate (≤70% of base, range clear
  of placebo: 6–16 vs 15–21). Rerun at N=10 on this fixture before judging it.
- The same build's cost ranges from $0.258 to $0.381 between base and placebo.
- The grader first scored a correct `file:line name` reply 0/21; fixed and
  replayed with `--replay`, which costs nothing.

**Harness facts the trace found** (file names stable, line numbers not):
- **Executor.** The live one is `runTools`. Unsafe calls run alone and in
  order, and before the guard nothing stopped later calls after a failure.
  `StreamingToolExecutor` runs only under the `streaming_tool_execution2`
  gate, which is false.
- **`is_error`.** RunTests, Typecheck and Build do not set it on a red run;
  they report `exitCode`. `bun test | tail` reports 0.
- **Deferred tools.** One runs unloaded if its input validates, and there is
  no auto-load.
- **Edit results.** Edit, Write and Patch return a one-line success with no
  snippet.
- **Sub-agent prompts.** A fresh sub-agent's prompt is its own + Notes + env,
  never the main `# Harness`.
- **Side requests.** Title, prompt suggestion, memory extraction (every 15th
  eligible turn), away summary, compaction, WebFetch/WebSearch, and a
  background agent's summary fork every 30 s.
