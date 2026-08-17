---
name: code-graph-siblings-audited
description: Three sibling code-graph implementations audited 2026-08-17 (code-graph-mcp Rust, code-review-graph Python, codegraphcontext Python) — none publishes an honest measured win, four ideas kept, and one of them corrected our own study
type: reference
---

Three local sibling repos implementing the same feature we rejected, audited
read-only on 2026-08-17. Full write-up with `file:line` anchors:
`docs/tech/repo-map/prior-art.md`.

| repo | lang | backend | why it matters |
|---|---|---|---|
| `~/projects/code-graph-mcp` | Rust | embedded SQLite | most engineered; **edge confidence tiers** + clamp-with-provenance |
| `~/projects/code-review-graph` | Python | SQLite | already rejected 2026-08-08, unchanged since — [[code-review-graph-evaluated-rejected]] |
| `~/projects/codegraphcontext` | Python | FalkorDB default, Neo4j optional | four self-audits committed, all damning; churn×complexity hotspots |

**The meta-finding, and the strongest single argument in the whole study: three
independent teams built this and not one can show it beating the baseline on a
real repository.** `code-graph-mcp`'s bench hand-estimates `baseline_bytes` in a
comment over a 3-file synthetic fixture, uses bytes as a token proxy, and is
`--ignored` by default. `code-review-graph`'s honest eval mode scores **f1 = 0.0
on every row of every repo**, and its one fair comparable (`agent_baseline`) has
never published a result. `codegraphcontext`'s own inconsistency report indicts
its own audit report — the headline "98.3% CALLS accuracy" is measured against a
golden exported from the indexer itself, and honest accuracy vs source truth is
**84.6%**; its canonical onboarding example (`f1(f2(f3(10)))`) produces **zero
Function→Function edges** on the published wheel. The failure mode of this feature
class is not that the graph is hard to build — it is that **the graph is easy to
build and hard to evaluate**, so everyone ships a self-referential benchmark. We
nearly did too: our own acceptance criterion was an intuition about which files
"should" rank highly, and only a churn correlation showed the criterion was wrong.

**Four ideas kept** (only the first is about graphs):

1. **Edge confidence tiers** (`code-graph-mcp/src/domain.rs:99-106`) — an
   `ambiguous` tier for a cross-file edge whose target name has >1 same-language
   definition, their comment calling it *"the class behind the known
   false-positive flood."* That is exactly our `import()`/`export()` keyword
   catastrophe, and it is a **third option** we did not consider: not dropping the
   name and not keeping it, but tagging it, filtering via `min_confidence`, and
   **disclosing what was suppressed** (`ambiguous_edges_hidden`,
   `confidence_filtered`). One post-resolution pass, not threaded through every
   insert site. Better than the denylist our doc recommended, which flattened the
   ranking to 1.04×.
2. **Clamp with provenance** — `depth_capped`, `effective_max_depth`,
   `requested_max_depth`, `limit_hit`, `freshness_partial`. **Applicable to
   claudin today, independent of any index:** several of our caps are silent
   (`Glob`'s 100-path cap, the diff line budget) while `GrepTool`'s auto-pivot
   already reports how much wider the search was — this is that pattern, made
   uniform.
3. **Deterministic truncation with an oracle test** — pre-truncation sort
   `depth ASC, caller_count DESC, node_id ASC`, pinned by a test named
   `row_limit_truncation_matches_oracle`. Also: tool description length capped by
   test (200 chars), and management tools hidden from `tools/list` to save tokens.
4. **Churn × complexity hotspots** (`codegraphcontext` `simulator.py:498-546`) — a
   third independent convergence on **churn** as the ranking, supporting Lane C in
   `docs/tech/repo-map/README.md`. One flaw to not copy: the score is
   *multiplicative*, so a file with no recorded complexity scores 0 no matter how
   much it churns.

**How to apply:** before proposing or evaluating any code-graph feature, read
`docs/tech/repo-map/prior-art.md` §3 and demand a real-repo A/B against
`Grep`-and-read — every implementation here failed at evaluation, not at
construction. Two corrections these repos forced on our own record are logged in
[[repo-map-graph-topology-degenerate]] (bounded depth ≤2 is NOT degenerate, so
"nothing in between" was wrong) and [[code-review-graph-evaluated-rejected]] (the
`export const` blindness and the 203k-token cause were both misattributed). Also
note the index-size problem is consistent across implementations, so it belongs to
the approach: `code-graph-mcp`'s own figure of ~3.5 MB per 800 nodes extrapolates
to ~135 MB on claudin, the same order as the 284 MB measured for
`code-review-graph`. Its committed `code-graph.db` is a 0-byte placeholder, not a
shipped index.
