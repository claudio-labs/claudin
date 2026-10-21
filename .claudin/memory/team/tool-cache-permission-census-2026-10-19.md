---
name: tool-cache-permission-census-2026-10-19
description: Census A=10-12..15 vs B=10-16..19 (first window on 1.1.45/46) — $1,488→$596, uncached tail $234→$0, 10-15 expected-zeros hold; Git 5.7%; relief stubbed 30-s-old patch inputs; sideQuery spend (auto-mode classifier) was in no cost counter; permission decisions unpersisted — all four fixed on fix/census-2026-10-19
type: project
---

Windows are local days (UTC−3): A = 10-12T03Z..10-16T03Z, B = 10-16T03Z..10-20T03Z.
Method: one scratchpad walk (dedupe message.id / tool_use.id, main files first,
windows by record timestamp, `-tmp*` split out), plus `lookback-miss-census.ts
--since=4 --verbose`. At the time, `session-census.ts` filtered FILES by mtime,
not calls by time, so its per-project totals included pre-window calls
(81744358 showed $288 for "since 10-16"; in the window it was $17). Fixed on
the branch.

**A → B:** real cost $1,488 → $596 (7,646 → 3,516 calls). Uncached input $234 →
$0.03 (#302). Rewrites 28/$84 → 12/$26. Sub-agents $155 → $46, with no sub-agent
rewrite. Tool calls 10,630/230 err → 4,875/70. Built-in tools, excluding
ExitPlanMode and AskUserQuestion, went 1.4% → 1.3%. The headline drop is MCP
(infra-home-lab was idle in B) and plan feedback.

**10-15 expected-zeros, all hold in B:** classifier refusal denials 27 → 0 (the
caveat is that infra-home-lab, where they clustered, was idle). Read
`file_paths` of one, TaskOutput not-found, read-gate refusals and the phantom
"No agent was actually launched" warning (10 → 0, #301) are all 0. No tool
crash.

**Found in B, and what fix/census-2026-10-19 did about it:**
- **Git 5.7%, the worst built-in.**
  - 4× `gh pr checks` exit 1, for a failing check or for none yet, marked
    `is_error`. FIXED: `readOnlyAnswer` (`GitTool/errors.ts`) makes both an
    answer, the way #298 handled no-upstream. A failed check names
    `gh run view <id> --log-failed`.
  - 5× `git pull` refused for a dirty tree, all in ferrous-dns. The dirty files
    are the harness's own (`.claudin/memory/team/*`, the map-synced
    `search-strategy.md`). The diagnosis already names `--autostash`. Left to
    the user's config: `rebase.autoStash` is unset.
- **Relief clip stubbed recent INPUTS.** Both mid-turn clips in B (6b9e19e6
  18:12, cd29d57b 14:07, ~$2.9 each) stubbed the inputs of Patch/Write calls
  30 s to 2.5 min old. Each was followed within a minute by a new Patch whose
  patchText was the `[clipped: …]` placeholder, which `clipStubEcho` refused.
  The cause: the result window is 2 user turns, and an input went one round
  trip before its result. FIXED: `KEEP_RECENT_INPUT_RESULTS = 10`
  (`clipFrontier.ts`), for both lanes. Re-reads in the next 15 min were 4 and
  7, against 1 and 0 before; that is the result window, which is unchanged
  (clip-all's A/B).
- **Side queries were in no cost counter.** The exit `cost-state` minus
  transcript usage was $40 of $604 (6.6%) in B and 7.5% in A: queryHaiku,
  keep-alive pings and forks, which reach the tracker without a transcript
  line. `sideQuery()` reached neither. The auto-mode classifier (Opus),
  bashClassifier and permissionExplainer were missing from `/cost`,
  `--max-budget-usd` and the cost-state. FIXED: `addSideQueryCost`. Every
  spend is now kept per source in `cost-state.sourceUsage`; side queries stay
  out of the cache metrics. Their real size is still unmeasured: the next
  census reads it.
- **Permissions were not persisted.** B had 6 classifier denials, all correct:
  mitmdump recording bearer tokens ×3 (one a retry of the same denied
  command), an unredacted config print, sudo, and a /tmp write against "do not
  modify". 9 of 10 user rejections were ExitPlanMode feedback. Approvals,
  prompts and rule hits could not be counted. FIXED: each tool_result record
  carries `permissionDecision` {decision, source, reason, detail, waitMs}.
  Auto-mode verdicts are `classifier` now, not `config`. In
  `~/.claudin/settings.json`, 138 of the 230 allow rules are one-off literal
  commands: 51 on `/home/viudes/projects/claudio/…`, 40 on pre-reorg paths.
- **Media-cap strip** (81744358, Sonnet, playwright, 10-17 14:33-14:41): six
  rewrites of ~520k each, $12.6, half of B's rewrite dollars. This is the
  unbatched design the user chose ([[clip-frontier-stalls-on-image-blocks]]).
  The "mutated at 14 (text block removed)" break recurred on the second turn
  after a resume. Both are still open.
- **Context is the cost.** Cache reads were 71% of B, and main Opus calls
  averaged 318k. Free simulation (`relief-ceiling-sim.ts --since=2026-10-12
  --main --clip-all --min-event=band`, 221 main threads, 22 reach 300k): net
  savings as a share of main reads for 700k → 600k → 500k → 400k → 300k were
  4.2% → 5.4% → 7.9% → 9.8% → 11.3% clip-only. With `--starved-compact` they
  were 4.2% → 9.5% → 33.6% → 38.2% → 53.4%. Below 600k the gain is compactions
  (11-29, each a lost working context), not clips. These are upper bounds with
  no re-reads simulated, and no default changed. An input window of 10 instead
  of 2 moves every row by under 1.3%.
- `api_error` retries: 5 in B, 9 in A. All recovered on attempt 1. The record's
  `error.type: null` is the SDK's (`type ?? null` when the body has no
  `error.type`).

**How to apply:** the next census runs `session-census.ts`, whose "spend by
source" and "permission decisions" sections only fill from a build with this
branch. Count the classifier's share before deciding its model. Count
placeholder echoes per relief clip (expected 0) and gh-checks errors (expected
0). Related: [[tool-error-census-2026-10-15]], [[cache-break-census-2026-10-15]].
