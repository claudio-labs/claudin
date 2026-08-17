---
name: repo-map-graph-topology-degenerate
description: No graph-based repo index works on this repo — measured 2026-08-16/17: PageRank ranks anti-correlated with churn (ρ=−0.10) and BOTH import-closure directions are constants, so every "neighbourhood" query returns the same ~22-24k tokens
type: project
---

The 2026-08-07 rejection ([[repo-map-rejected-orientation-measured]]) ended with
"do not re-open without new measurement". That measurement was done on
2026-08-16/17, against a faithful prototype of the algorithm plus two variants
proposed since. **The answer is still no, now for structural reasons that no
implementation quality can change.** Full write-up and reproducible probe:
`docs/tech/repo-map/` and `scripts/bench/repomap/` (scripts 01–09).

**Why — four independent failures, in the order they were found:**

- **Identifier tokenization does not extract references.** 64.4% of 1.17M
  identifier occurrences resolve to no definition; the graph is 260k edges over
  3.7k nodes (avg out-degree 70). The #1-ranked file won on two *keywords*:
  `TokenUsageTracker` declares methods named `import()` and `export()`
  (`src/agent/context/tokenAnalytics.ts:196,203`), which `scanSymbols` correctly
  reports as defs, and 98.4% of that file's inbound weight came from those two
  names. The proposed keyword denylist is mandatory and does not fix it — it
  flattens the 1st/2nd score ratio to **1.04×**.
- **Centrality is not what people edit.** Import-graph PageRank vs churn over
  2,000 commits: **0/50 overlap** in the top 50, Spearman **ρ = −0.104**.
  Centrality finds leaf primitives (`log.ts`, `debug.ts`, `errors.ts`); churn
  finds tool surfaces (`FileReadTool.ts` 27 commits, `BashTool.tsx` 22). PageRank
  ranks sinks, so the acceptance criterion (`query.ts`, `Tool.ts`,
  `QueryEngine.ts` at the top) is unreachable by *any* centrality — `query.ts`
  lands #550–#1,634 across five variants.
- **Both closure directions are constants.** This is the decisive one, and it
  kills the on-demand tool variant too, not just the head-injected map. Reverse
  closure: p50 = p90 = 2,462 of 3,359 nodes. Forward: **67.8% of files have a
  closure of exactly 2,361**, only **50 distinct sizes across 3,360 files**. So
  `impact_of(X)` and "focused neighbourhood of X" return the same ~22–24k tokens
  for `FileReadTool.ts`, `BashTool.tsx`, `GrepTool.ts` and `effort.tsx` alike —
  an operation whose output does not vary with its input. Only the **direct**
  edges carry information (forward p50 3 / p90 13, reverse p50 1 / p90 9), and
  those are one `Grep`. This also **corrects** the 2026-08-08 audit
  ([[code-review-graph-evaluated-rejected]]), which blamed its 203k-token impact
  answer on a 284 MB database and a broken parser: a perfect parser over a 200 KB
  in-memory graph returns the same constant. It is the topology of a
  single-entrypoint bundle, not a defect.
- **A static tree cannot hold exports.** There are 10,841 non-test top-level
  exports in `src/`; every name comma-joined is ~56k tokens. A directory tree is
  83 tokens at depth 2 (≈ what AGENTS.md already narrates) and 2,108 at depth 3.
  So "tree + public exports in ~800 tokens" is off by ~70×.

**How to apply:** treat any graph/index/PageRank/SQLite-symbol-table repo-map
proposal as **settled no** for this repository, and cite the closure numbers
rather than re-deriving them — that is the argument that generalizes, because it
holds for symbol-level and file-level graphs equally. Two things it does NOT
claim: `who_calls`/`defines` are worth building (they already ship as `LSPTool`
`findReferences`/`goToDefinition`, which was removed once for **zero usage** —
[[lsp-tool-reintroduced-plugin-only]]), and the degeneracy generalizes to other
codebases (it very likely does not hold for a multi-package monorepo; re-run
`scripts/bench/repomap/09-forward-closure-size.ts` there first). Also drop
tree-sitter from any such proposal: `scanSymbols` already covers 32 languages
with zero dependencies, and the real tree-sitter blocker is elsewhere
([[symbol-parser-options-researched]]).

What survived both studies is not an index at all — see
[[rule-files-two-silent-failure-modes]] for the map *verifier*.
