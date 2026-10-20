---
name: tool-cache-permission-census-2026-10-19
description: Census A=10-12..15 vs B=10-16..19 (first window on 1.1.45/46) — $1,488→$596, uncached tail $234→$0, every 10-15 expected-zero holds; built-in tool errors flat 1.4%→1.3%; Git 5.7% (dirty-tree pull ×5, gh checks exit-as-error ×4); media-cap strip $12.6 in 10 min; 7% of spend is side queries no transcript records; permission approvals are not persisted
type: project
---

Windows are local days (UTC−3): A = 10-12T03Z..10-16T03Z, B = 10-16T03Z..10-20T03Z.
Method: one scratchpad walk (dedupe message.id / tool_use.id, main files first,
windows by record timestamp, `-tmp*` split out), plus `lookback-miss-census.ts
--since=4 --verbose`. `session-census.ts` filters FILES by mtime, not calls by
time, so its per-project totals include pre-window calls (81744358 showed $288
for "since 10-16"; in-window it was $17).

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

**Open in B:**
- **Git 5.7%, the worst built-in.**
  - 5× `git pull` refused for a dirty tree, all in ferrous-dns. The dirty files
    are the harness's own (`.claudin/memory/team/*`, the map-synced
    `search-strategy.md`), and the global config has `pull.rebase=true` with no
    `rebase.autoStash`.
  - 4× `gh pr checks` (pending, failing or none) exiting non-zero. They were
    marked as errors and stopped the batch, the same shape as the no-upstream
    answer #298 fixed.
- **Media-cap strip** (81744358, Sonnet, playwright, 10-17 14:33-14:41): six
  rewrites of ~520k each, $12.6, which is half of B's rewrite dollars. This is
  the unbatched design from [[clip-frontier-stalls-on-image-blocks]], and the
  "mutated at 14 (text block removed)" break recurred on the second turn after
  the resume.
- **Relief clip-all keeps only the last 2 results.** Both mid-turn clips in B
  (6b9e19e6 18:12, cd29d57b 14:07, ~$2.9 each) stubbed Patch inputs 30 s old.
  Each was followed within a minute by a Patch whose patchText was the
  `[clipped: …]` placeholder; `clipStubEcho` refused it, costing one round
  trip. Re-reads in the next 15 min were 4 and 7, against 1 and 0 before.
- **Context is the cost.** Cache reads were 71% of B. Main Opus calls averaged
  318k. Reads above 400k cost $61 in 4 days (above 300k, $117) across 6
  sessions, against a 1M relief trigger near 735-750k. This is an upper bound
  and needs an A/B with a placebo.
- **Invisible side queries.** The exit `cost-state` minus transcript usage was
  $40 of $604 (6.6%) in B and 7.5% in A. That gap is what reaches the cost
  tracker without a transcript record: queryHaiku calls, keep-alive pings and
  forks. The auto-mode classifier is in NEITHER: `sideQuery()` never called
  `addToTotalSessionCost`, so its Opus spend was missing from `/cost` too.
- **Permissions.** B had 6 classifier denials, all correct (mitmdump recording
  bearer tokens ×3, one of them a retry of the same denied command; an
  unredacted config print; sudo; a /tmp write against "do not modify"). 9 of 10
  user rejections were ExitPlanMode feedback. Approvals and classifier calls are
  NOT persisted (`toolDecisions` in `permissionLogging.ts` is in-memory only),
  so prompts cannot be counted. In `~/.claudin/settings.json`, 138 of the 230
  allow rules are one-off literal commands, 40 of them on pre-reorg paths.
- `api_error` retries: 5 in B, 9 in A. All recovered on attempt 1, but the
  record stores `error: {type: null}`.

**How to apply:** re-run this comparison after any fix above. Count Git dirty-tree
and gh-checks errors, media-cap rewrites per screenshot, and placeholder echoes
per relief clip. Related: [[tool-error-census-2026-10-15]],
[[cache-break-census-2026-10-15]].
