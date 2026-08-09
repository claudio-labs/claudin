---
name: code-review-graph-evaluated-rejected
description: The code-review-graph tree-sitter code-graph tool was audited 2026-08-08 and its graph REJECTED on measured data (284 MB db on claudin, TS parser blind to export const, impact answer = 203k tokens); four graph-free ideas kept
type: project
---

`~/projects/code-review-graph` (tirth8205, Python, ~91k LOC, MIT) builds a
tree-sitter graph in SQLite and serves 30 MCP tools for blast radius / impact /
semantic search / risk-scored PR review. Audited 2026-08-08 against claudin.

**Verdict: do not port the graph.** Measured, clean-room, on claudin's own `src/`
(crg 2.3.7, 3,057 TS/TSX files, 728,333 LOC):

- `graph.db` = **284 MB**, 8.6× the 33 MB source tree. Cold build 18.4 s wall.
- The TS parser is blind to `export const X = …`: **445 of 495** such symbols have
  no node — `AgentTool`, `ApplyPatchTool`, `getSystemContext` all absent. That is
  claudin's dominant idiom, so the graph would be wrong before it was slow.
- `impact --base HEAD~1` on a 2-file change returned **813,823 chars ≈ 203k tokens**,
  truncated at 500 of 2,013 nodes, calling 236 files "affected".

**Their headline numbers do not support the premise:**

- "~65x fewer tokens" = *whole corpus* ÷ *a top-5 pointer list* (`token_benchmark.py:30-96`).
  Their own `README.md:239` calls it "an upper bound no real agent pays", and the
  pointer list is not an answer — the Reads it implies are never counted.
- The benchmark that measures the real scenario (`eval/benchmarks/token_efficiency.py`)
  shows the graph **losing 10–50×**: fastapi naive 6,045 → graph 195,653 tokens.
- 0.69 impact F1 is graph-derived ground truth (`impact_accuracy.py:151`) — recall
  1.0 is true by construction. The honest co-change mode scores **F1 0.000 on all
  13 commits**; commit `8257a56` says "NOT usable".
- `context_savings.py:76` clamps `max(0, baseline − returned)`, so the shipped
  "Token Savings" panel can never report a loss.
- Zero adoption measurement — nothing checks whether a model picks the graph over Grep.
- `eval/benchmarks/agent_baseline.py` is the one honest comparable (grep → read top-3
  vs graph). It is wired into CI and has **never published a result**.

This independently reinforces [[repo-map-rejected-orientation-measured]]: a second
project's own data fails to show a static/derived index beating grep-and-read.

**What was kept** (all graph-free, none beats D3 in [[dev-tooling-token-roadmap]]):

1. **Symbol-level diff summarizer** — map `git diff` hunk ranges onto symbol ranges
   (`changes.py:268-305`). Claudin already has the parser (`scanSymbols.ts`, 33
   languages), so this is effort S with no new deps and no index: `/diff` and
   `/code-review` emit "changed: `foo()`, `Bar.baz()`" instead of raw hunks.
2. **Churn + coverage + security-keyword risk score** (`changes.py:313-374`) — pure
   `git log --numstat --since`, explainable, orders the `/code-review` finder agents.
3. **Response-shaping trio** — one shared `compact_response()` with per-field caps and
   omit-when-empty (`tools/_common.py:265`); `detail_level:"minimal"` returning
   *counts plus a thresholded label* instead of lists; budget enforced **inside** the
   traversal loop with an explicit `truncated` flag rather than post-hoc slicing
   (`tools/query.py:980`).
4. **Eval-harness methodology** — per-repo YAML pinning an upstream SHA, dated CSVs
   committed so re-captures diff, `status=ok|error|skipped` rows kept for forensics
   but excluded from aggregates, and each guard's docstring naming the exact past bug
   it fixes. Fits R4 record&replay in [[roadmap-2026-07]].

**Also surfaced (claudin-side, cheapest of all):** `LSPTool` already has
`prepareCallHierarchy`/`incomingCalls`/`outgoingCalls` (`src/tools/LSPTool/schemas.ts`),
but the `/code-review` skill's allowed tools are only `Read` and `Grep`
(`src/skills/bundled/code-review.ts:524-525`), so its 7–9 finder agents re-derive
callers by grep every run. The capability exists and is unwired — see
[[lsp-tool-reintroduced-plugin-only]] for why no server ships built in.
