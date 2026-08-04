---
name: dev-tooling-token-roadmap
description: Ranked roadmap for the next dev-loop token savings (Grep budget, git diff wrapper, Read re-read dedup, redirect coverage, build wrapper), backed by a 2026-08-04 transcript measurement
type: project
---

Roadmap decided 2026-08-04, after RunTests and Typecheck shipped. Ranks what to
wrap NEXT in the detect/parse/budget/redirect family, using measured spend rather
than intuition.

**Why:** the first two wrapper tools were built where the idea was obvious, not
where the tokens were. The measurement says they landed on a small target, so the
next picks should follow the numbers.

**How to apply:** when picking the next token-efficiency work, start at D1. Cite
the measurement below rather than re-deriving it; re-measure with the same method
before claiming a win.

## Measurement (2026-08-04, method reusable)
34 session transcripts in `~/.claudin/projects/-home-viudes-projects-claudin/*.jsonl`
covering 2026-07-28 → 2026-08-04: 2,152 main-thread tool calls, 2,746,075 chars of
`tool_result` (~686k tokens). Aggregate with `jq`/`python3` over the JSONL — never
Read those files. Sub-agent sidechains live in separate files and are NOT in these
totals.

| tool | calls | ~ktok | share |
|---|---|---|---|
| Read | 429 | 340 | 49.5% |
| Bash | 846 | 161 | 23.5% |
| Grep | 232 | 126 | 18.3% |
| Typecheck + RunTests | 132 | 22 | 3.2% |

Read+Bash+Grep = 91% of all tool-result chars. Inside Bash: `git` 25%, `bun` 14%.
`head` appears 399× and `tail` 265× across Bash calls — the agent hand-rolls output
capping on most calls, which is the tell for missing coverage.

## Ranked (D1 → D5)

### D1 — Grep budget (~126k tok surface, effort S) — PARTLY DONE 2026-08-04
212 of 232 Grep calls run `output_mode:"content"` (mean 2,336 chars) vs 20 in
`files_with_matches` (mean 355); the largest calls pass no `path`/`glob`.

Landed on `feat/grep-context-summarizer` — but summarizer-side, not as the
`src/tools/GrepTool/budget.ts` this item proposed. The existing `grep-grouped`
strategy already had the per-file cap and dedupe; what it lacked was parsing rg's
`path-NN-text` context lines at all, so a context-heavy result fell into the
literal bucket and the no-win guard shipped it whole. Fixing that plus the header
accounting took the take from **10.0% to 15.5%** of all Grep chars (20.5% → 33.5%
of the context-bearing ones) over 5,096 recorded results. Also fixed there: rg
context lines leaked absolute paths, worth 4.5% on its own.

Still open from this item: the auto-pivot to `symbols`/`files_with_matches` past
a line threshold (the FileReadTool auto-outline shape), which is the part that
would cut the calls that pass no `path`/`glob`. The dispatch floor is now a
two-tier gate — see `GREP_SUMMARIZE_FLOOR` — so anything further has to keep the
"never trade a match locator below the full threshold" rule it establishes.

### D2 — `git diff` wrapper (103k chars in 21 calls, effort M)
The single largest Bash command shape (mean 4,903 chars, max 16,819; 16% of all
Bash chars). A Diff/Review tool returning stat + summarized hunks with
expand-on-demand per file fits the Typecheck mould, with merge-base playing the
role of the baseline. Runs in nearly every session because it gates every commit.

### D3 — Read re-read dedup (~160k tok, effort M, delicate)
196 of 429 Read calls (639,163 chars) re-read a path already read in the same
session. Existing clip-pin / dedup stand-down only covers entries a prior FULL
Read wrote; the gap is "file unchanged since your last read" → return the delta,
not the body. Touches the clip-frontier cache invariant, so plan it separately.

### D4 — Make the existing redirects actually fire (52k chars, effort S)
99 Bash calls contained `bun run typecheck`/`tsc --noEmit` (52,471 chars) against
only 15 Typecheck calls; 64 test-ish Bash calls against 117 RunTests calls (mean
337 chars vs 779 for the Bash equivalent). The redirects are narrow by design
(single command, must start with the runner, no quotes, opt-out flags), so most
real invocations escape via compound commands or a trailing `| tail`. Widening the
matcher needs no new tool.

### D5 — Build wrapper (80 calls, 26.5k chars, effort S)
`bun run build` / `bun run smoke` have no wrapper at all and are always followed by
a hand-written `| tail -N`. Natural third member of the
detect/parse/budget/redirect family — see `runtests-tool-language-coverage.md` and
`typecheck-tool-baseline-design.md` for the shape, and reuse
`src/tools/shared/sourceExcerpt.ts`.

## Shared-code debt this exposes
`RunTestsTool/` and `TypecheckTool/` duplicate their `redirect.ts` (both
re-implement `SHELL_COMPOSITION_RE` + `OPT_OUT_FLAG_RE` + a 100-entry one-shot
memo) and their `budget.ts` caps. Only `src/tools/shared/sourceExcerpt.ts` is
genuinely shared. Factor those into `src/tools/shared/` when adding D2 or D5
rather than copying a third time. `RunTestsTool` also still lacks a `budget.test.ts`.

## Out of scope for now
`PowerShellTool` has no output filter (the `src/outputFilter/Bash/` pipeline is
Bash-only), and that filter's roadmap still defers `aws`/cloud CLIs, DB/secrets
and task runners. Related: [[tool-result-nudges-benched-zero-adoption]] — land any
new nudge flag-OFF as bench instrumentation, and
[[typecheck-ab-bench-fixture-flaw]] for how to A/B one of these honestly.
