# Prior art — three sibling code-graph implementations, audited

> **Status:** audited 2026-08-17 against the constraints measured in
> [`README.md`](README.md) and [`two-layer-viability.md`](two-layer-viability.md).
> **One of them corrected this study.** Bounded-depth traversal is not the same
> thing as a transitive closure, and at depth ≤2 directed it is *not* degenerate
> on this repo — so the claim "there is nothing in between the whole core and the
> direct edges" was wrong. Details in §2. Four ideas are worth taking; none of the
> three publishes an honest measured win.

Repos audited, all read-only, none built or run:

| repo | language | backend | state |
|---|---|---|---|
| [`code-graph-mcp`](https://github.com/) | Rust | embedded SQLite | most engineered of the three |
| `code-review-graph` | Python | SQLite | already rejected here 2026-08-08; unchanged since |
| `codegraphcontext` | Python | FalkorDB (Neo4j optional) | four self-audits committed, all damning |

## 1. Verdict

- **Nothing here rescues a global ranked map.** Centrality stays anti-correlated
  with churn ([README §5.6](README.md#56-centrality-is-not-what-people-edit)), and
  notably `code-graph-mcp` reaches for **betweenness** rather than PageRank, which
  is a different centrality with the same problem.
- **One thing corrects this study:** both `code-graph-mcp` and `code-review-graph`
  compute **bounded-depth neighbourhoods**, never closures. That shape was never
  measured here. It has been now (§2), and it survives at depth ≤2 directed.
- **Four ideas are worth taking** (§4), and only one of them is about graphs.
- **None of the three publishes an honest measured win** (§3). That is the
  meta-finding, and it is the strongest argument in this whole study: three
  independent teams built this feature and not one of them can show it beating the
  baseline on a real repository.

## 2. The correction — bounded depth is not a closure

Two of the three cap traversal depth:

| | shape | default depth | cap | source |
|---|---|---|---|---|
| `code-graph-mcp` | `get_call_graph`, BFS | **3** | `CALL_GRAPH_ROW_LIMIT = 200`, `CALL_GRAPH_MAX_DEPTH = 10` | `src/graph/query.rs:11,16` |
| `code-review-graph` | `get_impact_radius_sql`, bounded best-score relaxation over weighted edges | **2** | `MAX_IMPACT_NODES = 500` | `code_review_graph/constants.py:43-44`, `graph.py:1351` |

[`two-layer-viability.md` §4.5](two-layer-viability.md#45-both-directions-are-degenerate--the-graph-is-one-giant-core)
measured full closures and concluded a neighbourhood is "either the whole core or
the direct edges — there is nothing in between on this graph." That skipped the
bounded case, so it was measured
([`10-bounded-depth-neighbourhood.ts`](../../../scripts/bench/repomap/10-bounded-depth-neighbourhood.ts)),
3,361 nodes:

| direction | depth | p50 | p90 | distinct sizes | p90 answer |
|---|---|---|---|---|---|
| forward (deps) | 1 | 3 | 13 | 58 | ~111 tok |
| forward | **2** | **22** | **119** | **272** | ~1,012 tok |
| forward | 3 | 79 | 405 | 632 | ~3,443 tok |
| reverse (importers) | 1 | 1 | 9 | 88 | ~77 tok |
| reverse | **2** | **6** | **122** | **286** | ~1,037 tok |
| reverse | 3 | 22 | 559 | 549 | ~4,752 tok |
| undirected | 1 | 5 | 22 | 103 | ~187 tok |
| undirected | 2 | 353 | 1,044 | 1,126 | ~8,874 tok |
| undirected | 3 | **2,089** | 2,731 | 1,634 | ~23,214 tok |

**The claim was wrong.** Directed depth 2 is a genuine middle ground: 272–286
distinct answer sizes, p50 of 6–22 files, p90 answer around 1k tokens. It is not
a constant, and it is not one `Grep` either. Undirected depth 3 (p50 2,089) is
where the answer falls back into the core, which is what §4.5 actually measured.

**But the two shipped configurations both blow their caps on the files that
matter.** Applying their real defaults to claudin's churn leaders:

| file | churn | crg d2 undirected (cap 500) | cg-mcp d3 reverse (cap 200) |
|---|---|---|---|
| `src/tools/FileReadTool/FileReadTool.ts` | 27 | 1,307 → **capped** | 558 → **capped** |
| `src/tools/BashTool/BashTool.tsx` | 22 | 1,695 → **capped** | 398 → **capped** |
| `src/tools/AgentTool/AgentTool.tsx` | 19 | 1,627 → **capped** | 180 |
| `src/tools/GrepTool/GrepTool.ts` | 13 | 935 → **capped** | 188 |
| `src/commands/effort/effort.tsx` | 11 | 565 → **capped** | 196 |

Eight of ten churn leaders exceed `code-review-graph`'s 500-node cap at its
default depth 2 undirected. That independently reproduces what the earlier audit
saw from the other side — it reported depth 2 on claudin reaching 2,013 nodes and
hitting the cap — and it explains the 203k-token answer without invoking the
database size at all (§5).

**Net effect on this study:** the *shape* is viable at depth ≤2 **directed**; the
shipped *defaults* are not, because undirected already doubles the radius. Whether
depth-2 directed beats `Grep` (which answers depth-1 reverse in one call) is
**still unmeasured** — it is exactly Gate 1, and it is now a live question rather
than a closed one.

## 3. What each publishes vs. what it measures

This is the section worth reading twice. All three make efficiency claims; the
measurement behind each is weaker than the claim.

**`code-graph-mcp`** — `tests/effectiveness_bench.rs` turns the README's "40–60%
savings" into a tracked ratio, but `baseline_bytes` are **hand-estimated** in a
comment (*"Estimate: ls ~500 bytes + 5 × 1500 byte file reads = ~8000"*), the
fixture is **3 synthetic TypeScript files**, bytes stand in for tokens, and the
test is `--ignored` by default. It is not a real-repo A/B. Its own audit
(`docs/AUDIT-REPORT-2026-07-24.md`) is however genuinely self-critical: 1,290
Rust tests passing, and it **blocks release** on a live false-edge bug where
`matches!(x, Some(y))` emits a phantom `calls → Some` edge.

**`code-review-graph`** — the honest half of its eval reports failure.
`impact_accuracy` was re-measured 2026-08-02 across 7 repos, and the CSV now
self-labels its circular mode `graph-derived (circular — upper bound)`, which is a
real integrity improvement. The non-circular mode, co-change, is **f1 = 0.0 on
every row of every repo.** `token_efficiency` has not been re-measured since
2026-05-25, so the earlier "graph loses to reading the diff" result stands
unrevisited, and `agent_baseline` — the one honest comparable — publishes **no
results at all**.

**`codegraphcontext`** — its own inconsistency report indicts its own audit
report. `CGC_GRAPH_INCONSISTENCIES.md:98-99` files two high-priority items:
*"Circular perfection gate (export vs itself) → **Misleading 21/21 PASS**"* and
*"**CALLS avg 84.6% vs perfection 100%**"*. So the headline "98.3% CALLS accuracy"
at `CGC_CALL_GRAPH_AUDIT_REPORT.md:15` is measured against a golden exported from
the indexer itself; against source truth it is **84.6%**. The denominators are toy
besides — its dart row reports *"CALLS accuracy: 80.0% (1 missing)"* on 5 total
calls.

Worse, its canonical onboarding example is broken on the published wheel. On the
fixture `f1(f2(f3(10)))` the indexer produces **zero Function→Function CALLS
edges**, only `<module>→f1/f2/f3`, so `analyze chain f1 f3` answers *"No call
chain found"* and `analyze callers f2` answers `<module>` instead of `f1`
(`CGC_E2E_BUG_REPORT.md:66-93`). Fixed in the working tree, never released. Also
recorded there: `cgc delete` leaves **9 orphan nodes instead of 0**; node counts
drift from goldens on **11 of 20 languages, up to +170%**, and the inflation is
extra `Parameter`/`Variable` nodes while edge counts match exactly — the graph is
padded with non-semantic nodes.

**Read together:** the failure mode of this feature class is not that the graph is
hard to build. It is that **the graph is easy to build and hard to evaluate**, so
every implementation ships with a self-referential benchmark. Our own study came
close to the same trap — [README §5.4](README.md#54-the-ranking-fails-its-own-sanity-check-and-not-marginally)'s
acceptance criterion was an intuition about which files "should" rank highly, and
it took a churn correlation to show the criterion itself was wrong.

## 4. Ideas worth taking

### 4.1 Edge confidence tiers — the answer to our keyword catastrophe

`code-graph-mcp/src/domain.rs:99-106` defines an `ambiguous` tier: *a cross-file
`calls`/`references` edge whose target name has more than one same-language
definition — the by-name resolution could not pick uniquely.* Their own comment
calls it *"the class behind the known false-positive flood."*

That is **precisely** the failure measured in
[README §5.4](README.md#54-the-ranking-fails-its-own-sanity-check-and-not-marginally):
`TokenUsageTracker` declares methods named `import()` and `export()`, and 98.4% of
the winning file's inbound weight came from those two names. This study concluded
the problem was unfixable, because the proposed keyword denylist flattens the
first/second score ratio to 1.04×. **Confidence tiering is a third option that was
not considered:** instead of dropping ambiguous names or keeping them, tag them,
let the caller filter with `min_confidence`, and — the part that matters —
**disclose what was suppressed** (`ambiguous_edges_hidden`,
`impact.ambiguous_callers_excluded`, `confidence_filtered`). Implemented as one
post-resolution pass (`classify_edge_confidence`) rather than threaded through
every insert site, and `confidence_rank` ranks unknown strings 0 so a corrupt
value can never pass a stricter filter.

This does not resurrect the global map — a tiered graph still ranks sinks — but it
is the right shape for any by-name resolution, and it is a better answer than the
denylist this study recommended.

### 4.2 Clamp with provenance — directly applicable to claudin today

`code-graph-mcp` clamps silently but *reports the clamp in band*:
`depth_capped`, `effective_max_depth`, `requested_max_depth`, `limit_hit`,
`freshness_partial`. The caller always knows it got a partial answer and why.

Claudin has several silent caps that could carry the same provenance — `Glob`'s
100-path cap, the `Grep` summarizer thresholds, `DIFF_FILE_LINE_BUDGET`. Some
already report (`GrepTool`'s auto-pivot says how much wider the search was), which
is exactly this pattern; others do not. This is a **non-graph, shippable**
improvement that stands on its own regardless of whether any index is ever built.

### 4.3 Deterministic truncation with an oracle test

Before truncating to `CALL_GRAPH_ROW_LIMIT`, they sort by
`depth ASC, caller_count DESC, node_id ASC`, and pin it with a test named
`row_limit_truncation_matches_oracle` (`src/graph/query.rs:874`). Our own Gate 2
requires determinism and found 905 exact float score ties; this is the pattern for
making a truncated list stable rather than incidentally ordered.

They also cap **tool description length by test** (200 chars, `tools.rs:226`) and
hide 4 management tools from `tools/list` to save tokens — the same instinct as
`src/tools/TypecheckTool/prompt.ts:1` and the `prompt.test.ts` convention here.

### 4.4 Churn × complexity — independent convergence on Lane C

`codegraphcontext/src/codegraphcontext/core/simulator.py:498-546` computes
`hotspot_score = (churn/max_churn) × (complexity/max_complexity) × 100`, where
churn comes from `git log` and the graph contributes only a per-file scalar — no
traversal at all. A second tool, `get_growth_trend`, is pure
`git log --shortstat`.

So a third independent implementation also lands on **churn** as the ranking with
a defensible relationship to what people edit, which is
[README §8](README.md#lane-c--churn--recency-list--documented-not-built)'s Lane C.
One flaw to not copy: the score is **multiplicative**, so a file with no recorded
complexity scores 0 no matter how much it churns — the same trap as multiplying by
any graph metric.

### 4.5 One anti-pattern to avoid

`code-review-graph/hooks/session-start.sh` injects a **mandate**: *"prefer using
the code-review-graph MCP tools before scanning files manually… Fall back to
Grep/Glob/Read only when the graph does not cover what you need."* That is how
they answer the adoption question — by instruction rather than by evidence. It is
the exact pattern claudin measured at **zero adoption** for appended
`<system-reminder>` nudges (team memory `tool-nudges-benched-zero-adoption`). If a
tool needs a prompt mandate to get used, that is the measurement, not the fix.

Their staleness answer is more interesting and worth noting: a `PostToolUse` hook
on `Write|Edit|Bash` re-indexes synchronously with a 30 s timeout, plus a
background full rebuild on `EnterWorktree` (claudin has that event too). It prices
staleness honestly — as latency on every edit.

## 5. Corrections to the record

Two things this repo's memory asserted are wrong, both about `code-review-graph`:

1. **"TS parser blind to `export const`"** — it is not. It resolves the
   initialiser: arrow and function expressions become `Function` nodes. What it
   misses is **call expressions and object literals**. That distinction matters
   because claudin is built almost entirely from the forms it misses — **476**
   `export const X = call(`, **293** `export const X = {`, against only **72**
   arrow forms — so the real misses are `getSystemContext = memoize(…)`
   (`src/agent/context.ts:116`) and `AgentTool = buildTool({…})`
   (`src/tools/AgentTool/AgentTool.tsx:215`). The 445-of-495 outcome was right;
   the stated cause was not, and the defect is narrow and fixable rather than
   architectural.
2. **"The 203k-token impact answer was caused by the degenerate closure"** — this
   study's own claim, and it is wrong for that repo. Their query is depth-2,
   ranked, capped at 500 nodes; it never computes a closure, so the degeneracy
   cannot be levelled at it. The real cause is **response shaping**: depth 2 on
   claudin already reaches ~2,013 nodes, hits the cap, and the **default**
   `detail_level="standard"` emits 500 full node dicts plus edges plus
   impacted_files at roughly 1,628 chars per node. A `minimal` mode exists that
   returns a risk label, a count and 5 key entities. The lesson generalises: an
   answer-size failure is usually a *serialization* choice, and it is worth
   checking that before blaming the algorithm.

Also worth recording: `code-graph-mcp`'s committed `code-graph.db` is **0 bytes**
— a placeholder, not a shipped index — and its own README figure of ~3.5 MB per
800 nodes extrapolates to roughly **135 MB** on claudin's ~31k symbols, the same
order as `code-review-graph`'s measured 284 MB. The index-size problem is
consistent across implementations, so it is a property of the approach rather than
of one codebase.

## 6. What changes here

- [`two-layer-viability.md` §4.5](two-layer-viability.md#45-both-directions-are-degenerate--the-graph-is-one-giant-core)
  is corrected by §2: bounded directed depth ≤2 is a real middle ground, so
  "nothing in between" overstated the result.
- [README §8](README.md#8-revised-design--three-lanes)'s Lane A is **partially
  reinstated**, in a much simpler form than originally designed: bounded-depth
  directed neighbourhood, **no PageRank, no personalization vector, no ranking at
  all** — depth is the budget. Gate 1 still decides it, and Gate 1 is still
  unmeasured.
- §4.2 (clamp with provenance) is worth doing whether or not any index is built,
  and does not belong to this feature.
- Nothing here reopens Lane B, the global map, or the SQLite symbol graph.
