---
name: repo-map-graph-topology-degenerate
description: NO repo index of any shape works on this repo — closed 2026-08-17 after Gate 1 ran offline over 96 real sessions: forward depth 2 recalls a MEDIAN OF 0% and loses to one `ls` of the seed's directory; the signals that work are directory locality plus direct importers, i.e. Glob and Grep
type: project
---

The 2026-08-07 rejection ([[repo-map-rejected-orientation-measured]]) ended with
"do not re-open without new measurement". That measurement was done on
2026-08-16/17, against a faithful prototype of the algorithm plus two variants
proposed since. **The answer is still no, now for structural reasons that no
implementation quality can change.** Full write-up and reproducible probe:
`docs/tech/repo-map/` and `scripts/bench/repomap/` (scripts 01–13; stopping at 07
reproduces only the first half of the study).

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
  an operation whose output does not vary with its input.
- **A static tree cannot hold exports.** There are 10,841 non-test top-level
  exports in `src/`; every name comma-joined is ~56k tokens. A directory tree is
  83 tokens at depth 2 (≈ what AGENTS.md already narrates) and 2,108 at depth 3.
  So "tree + public exports in ~800 tokens" is off by ~70×.

**The exception, measured 2026-08-17 — do not overstate this memory.** A
**bounded-depth** traversal is not a closure, and at **directed depth ≤2** it is
*not* degenerate here: forward d2 p50 22 / p90 119 with **272 distinct answer
sizes**, reverse d2 p50 6 / p90 122 with **286**. The collapse into the core
happens at *undirected* depth 3 (p50 2,089). An earlier version of this memory
said "there is nothing in between the core and the direct edges" — that was
wrong, and it also wrongly blamed
[[code-review-graph-evaluated-rejected]]'s 203k-token answer on this degeneracy:
their query is depth-2 capped and never computes a closure, so the real cause was
serialization. So what is settled is that **ranking** is dead (PageRank,
betweenness, personalization vectors) and that **closures** are dead. A
depth-≤2 directed neighbourhood with *no ranking at all* — depth is the budget —
remains an open question, undecided until an A/B against `Grep` runs. Note that
both shipped sibling implementations blow their own node caps on claudin's churn
leaders at their default settings (8 of 10 exceed 500 at undirected depth 2).

**Repriced 2026-08-17 — the surviving shape was a LIST OF PATHS, not an
outline.** The "p90 ~1k tokens" that reinstated it prices a member at ~34 chars,
a bare repo-relative path. Rendered as the definition signatures the design
specifies, a file costs a **mean of 105 tokens** (p50 59, p90 231, max 3,439), so
the same neighbourhood is **16–22× more expensive**: forward d2 is 5,728 tok p50
and **22,639 p90** — the whole core's price — and on the churn leaders it is
**33.9k–69.3k**. The 8.6× estimate implied by `measurements.md` §7 was itself too
low, because those 14 files were the ones that *fit* a 1,024-token budget. So the
affordable form was 187 tok p50 / 1,012 p90 of paths. Two audits in the same pass cleared the
graph itself: imports inside comments are 0.21% of edges (real, immaterial), and
neither the 21% unresolved specifiers (96.8% bare packages and `node:` builtins)
nor the 22.2% empty reverse-depth-2 balls (99.5% tests, `scripts/`, `.d.ts`,
entrypoints; residue of 4 files) is a resolver hole.

**CLOSED 2026-08-17 — Gate 1 ran offline and every lane is dead.**
`scripts/bench/repomap/14-oracle-recall.ts` scores each arm against **96 real
sessions** from the local transcripts: seed = the first module file a session
touched, ground truth = every other module file it touched afterwards (p50 5,
mean 8.9).

| arm | files p50 | recall p50 | recall/1k tok |
|---|---|---|---|
| **fwd d2** | 29 | **0.0%** | 1.08 |
| rev d2 | 33 | 21.4% | 2.27 |
| undir d1 | 12 | 25.0% | 3.17 |
| **same-dir** (one `ls`) | **12** | **33.3%** | **4.68** |
| same-dir + rev d1 | 20 | 50.0% | 3.35 |
| undir d2 | 163 | 75.0% | 0.45 |
| random, sized to fwd d2 | 29 | 0.0% | 0.03 |

Forward depth 2 — the configuration this memory kept alive — **finds nothing in
58.3% of sessions** and loses to the seed's own directory on files, recall,
precision (0.0% vs 13.0% p50) and recall per token. It does beat the chance floor
(2.7% mean), so this is not a broken implementation: it is a real signal worth
less than a free one. The reusable finding is the marginal test — adding
**reverse depth 1** to `same-dir` lifts median recall 33.3% → 50.0%, and reverse
depth 1 is exactly what one `Grep` for importers returns. **The two signals that
locate the next file here are directory locality and direct importers, and
`Glob`/`Grep` already serve both.**

**How to apply:** treat any graph/index/PageRank/SQLite-symbol-table repo-map
proposal as **settled no for this repository — every shape, not just the ranked
and closure-shaped ones.** Cite the numbers rather than re-deriving them: the
closure argument generalizes across symbol-level and file-level graphs, and Gate 1
covers the bounded-depth case that used to be the exception. Do not let a new
proposal quote the "~1k tokens" figure; it is the path-list price of an arm that
then lost to `ls`. Three more things it does NOT
claim: `who_calls`/`defines` are worth building (they already ship as `LSPTool`
`findReferences`/`goToDefinition`, which was removed once for **zero usage** —
[[lsp-tool-reintroduced-plugin-only]]), and the degeneracy generalizes to other
codebases (it very likely does not hold for a multi-package monorepo; re-run
`scripts/bench/repomap/09-forward-closure-size.ts` there first). Also drop
tree-sitter from any such proposal: `scanSymbols` already covers 32 languages
with zero dependencies, and the real tree-sitter blocker is elsewhere
([[symbol-parser-options-researched]]).

What survived both studies is not an index at all — see
[[rule-files-two-silent-failure-modes]] for the map *verifier*. Three sibling
implementations were audited for anything that beats this: [[code-graph-siblings-audited]].

**Limitation, so the next person can attack it properly:** Gate 1 is one user,
one repo, retrospective, with ground truth restricted to files the graph could
name at all — all three favour the graph, and it lost anyway. What it does NOT
establish is that handing an agent the arm would not change its behaviour; it is
enough to reject, not enough to accept.
