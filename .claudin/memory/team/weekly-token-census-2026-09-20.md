---
name: weekly-token-census-2026-09-20
description: Token/cost census of 2026-09-14..20 (13.7k calls, Opus 5 $2,081) — the 1M-window regime with ZERO compactions is the top lever ($355-580/wk of reads above 300k), retain-profile relief thrashes above ~700k and its big clips ARE the full rewrites, tool_use inputs are 40% of transcript chars and never clipped, 5m-TTL sub-agents expire behind >5-min Bash calls, refusals+edit-gate errors ≈ $77/wk
type: project
---

Census of Mon 2026-09-14 → Sun 09-20 (`session-census.ts --since=2026-09-14`,
plus `lookback-miss-census.ts --since=7`, `feature-usage-census.ts`, and four
read-only forensic agents over the transcripts). 13,754 calls (7,816 main /
5,938 sidechain). Opus 5: 11,121 calls, **$2,081 = reads $1,411 (68%) + writes
$273 + output $218 (thinking 38%) + uncached input $180**. Context per call
p50 167k / p90 507k / max 958k. The census script prices unknown models at the
Opus tier, so its $3,034 headline is wrong: glm/qwen/kimi lanes (OpenCode GO +
OpenRouter, ~2,300 calls) are ≈$110 at `modelCost.ts` family prices, not $920 —
`PRICES` in `session-census.ts` needs the glm/qwen/kimi rows.

**1. Nothing compacted on Opus 5 all week.** 0 compactions in any opus session
(17 autocompacts happened, all in the ~100k-limit flash-model sessions). 14 of
25 opus sessions exceeded 300k; 88f03ef5 ran 1,216 main calls at p50 687k
(max 958k, $462 main + $152 sub). Σ max(0, ctx−300k) over the window =
709M cache-read tokens = **$355** (Σ>200k: $580) — 96% of it in 8 sessions,
$219 in 88f03ef5 alone. `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE` already exists to
test a lower ceiling; nothing warns the user that a call at 700k costs $0.35.

**2. The retain profile cannot relieve a 1M window.** Trigger = 0.75×window ≈
750k, band 60k → target 690k. 88f03ef5's floor under the profile is ≈494k
nominal chars/4 (stub heads 236k + tool_use INPUTS 218k + system 27k) ≈ 780k at
the observed 2.5 chars/token — above the band, so the clipper fires on every
call and clips one result for ~0k: 149 `relief clip` entries, 140 of them
1-result, 114 of them ~0k. The 4 big ones (93/168/156/16 results) ARE the
session's 4 full-prefix rewrites (2.53M tokens of its 3.80M writes ≈ $25) —
"breaks the cache once per event" costs $7 per event at 730k (would be $14.6
on Fable 5.1's $20/M 1h writes). `applyStubs.ts` rewrites tool_result blocks
only; apply_patch/Write/ExitPlanMode inputs (872k chars = 40% of the
transcript) are never clipped, and the server-side `clear_tool_inputs` is
inert because `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS` defaults to true.

**3. Other rewrites (lookback census: 15 events, 5.66M tok, 30.6% of writes).**
3 "likely server-side" drops on a fresh human turn with <5 min gap and
input_tokens ~3.7k (no marker jump) — 1.08M tok ≈ $11, still unexplained
(85f91ea7 04:15, 40c1143a 00:43, 1563cec5 04:42). 3 are 1h-expiry + /resume
re-render (expected). 4 are **5m-TTL sub-agents whose Bash ran 7–14 min**
(timeouts 620–1250s) — 1.2M tok; the window had 505 Bash calls with
timeout ≥5 min, 277 ≥10 min, so any of them inside a sub-agent expires the
prefix. Fresh sub-agents = 142 files, $787 (36% of Opus); NO true forks in
the window (the fork gate refuses >150k parents, so every real sub-agent
starts at ~19k); 72 of 124 Agent calls passed `readOnly:true`.

**4. Wasted turns ≈ $77/wk.** 301 Bash refusals ($38.5 on Opus; 71% obeyed,
16% re-sent identical). RunTests is the least obeyed: 39 of 75 re-sent
identically (`bun test <file> 2>&1 | head/tail/grep`), 66 of 72 `bun test`
refusals were pipes wanting raw output. 152 apply_patch + 63 Edit errors
($38.6): ~87% are read-gate ("only read in part" / "not read yet" /
"modified since read"), apply_patch error rate 14.7%. 108 Bash calls blocked by
plan-mode read-only, 37 by the auto-mode classifier. WebFetch failed 15/31.

**5. Read/Grep shape.** Read 56% of tool-result chars; paths read ≥3× = 1,989
extra calls / 5.9M chars (38% of Read chars); slice-walks with no outline
first 339 paths / 1,666 calls / 3.9M; read-right-after-edit 324 calls.
Explicit outline 425 (7.6%, 333 by sub-agents) and 237 of them needed no
follow-up; `symbol=` only **25** (raw grep, deduped) — the 09-16 census's "79
symbol calls" is contradicted, see [[feature-usage-census-2026-09-16]]. Grep:
`head_limit:0` on 427 calls / 1.26M chars. 1h TTL premium $63 vs $225 of 5m
rewrites — keep 1h. Poll turns 156 ($23); WaitFor used 108×.

**What landed (branch `feat/census-2026-09-20-fixes`, 2026-09-20, unpushed
until hand-validated):** items 2/4/5/6 as one commit each — `perf(cache)`
input-side clip (`Tool.clearableInputFields` + `applyStableInputStubs`,
wire-only), band 15% of trigger past ~400k, `relief starved` instead of ~0k
clips; `fix(tools)` a `| head/tail/grep` tail opts out of the RunTests
redirect; `feat(permissions)` plan-mode Bash → classifier under auto mode +
`tengu_scratch` on by default + plan-mode rule bullets in the classifier
prompt; `chore(bench)` census prices glm/qwen/kimi and the `[Cache:]` line
folds repeated relief clips. Items 1 (context ceiling on 1M) and 3 (5m-TTL
sub-agent keep-alive) are NOT done. Every new test was break-probed
(`scripts/migrations/probes/{inputClip,runTestsRedirectTail,planModeClassifierLane,planModeClassifierPrompt}.json`).
Live validation still owed: a >700k Opus session with `--debug` (expect one
big `relief clip (… + N inputs …)` or `relief starved`, no 1-result runs) and
a plan-mode + auto-mode Bash pipeline reaching the classifier.

**Why:** the previous censuses ranked Read/injections; this week the cost is a
regime — Opus 5's 1M window with a relief policy tuned for 200k — and the
relief events themselves are the rewrites the lookback census was counting.

**How to apply:** rank levers by Σ max(0, ctx−T) before touching tool shapes;
the census dedupes by `message.id`/`tool_use.id` and one sub-agent's
classifier flagged its own config.json read (redacted, no secrets printed).
Related: [[weekly-token-census-2026-09-08]],
[[token-census-2026-09-10-hidden-injections]],
[[context-relief-unified-policy-ab]] (the 1M-window finding in full),
[[cache-ttl-tiering-subagents]] (the 5m-TTL long-Bash finding).
