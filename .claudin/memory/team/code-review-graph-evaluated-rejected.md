---
name: code-review-graph-evaluated-rejected
description: The code-review-graph tree-sitter code-graph tool was audited 2026-08-08 and its graph REJECTED on measured data (284 MB db on claudin, impact answer = 203k tokens); four graph-free ideas kept — re-checked 2026-08-17, unchanged, and TWO stated causes were wrong
type: project
---

`~/projects/code-review-graph` (tirth8205, Python, ~91k LOC, MIT) builds a
tree-sitter graph in SQLite and serves 30 MCP tools for blast radius / impact /
semantic search / risk-scored PR review. Audited 2026-08-08 against claudin.

**Verdict: do not port the graph.** Measured, clean-room, on claudin's own `src/`
(crg 2.3.7, 3,057 TS/TSX files, 728,333 LOC):

- `graph.db` = **284 MB**, 8.6× the 33 MB source tree. Cold build 18.4 s wall.
- **445 of 495** `export const X = …` symbols have no node — `AgentTool`,
  `ApplyPatchTool`, `getSystemContext` all absent. That is claudin's dominant
  idiom, so the graph would be wrong before it was slow. (**Cause corrected
  2026-08-17 — see below. It is not blind to `export const`.**)
- `impact --base HEAD~1` on a 2-file change returned **813,823 chars ≈ 203k tokens**,
  truncated at 500 of 2,013 nodes, calling 236 files "affected". (**Cause corrected
  2026-08-17 — see below.**)

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

---

**Re-checked 2026-08-17. The repo is unchanged** — HEAD `1a010de`, 2026-08-02,
v2.3.7, the exact state the audit ran against. The verdict stands, but **two of
the causes above were wrong**, and both corrections generalize:

1. **The parser is NOT blind to `export const`.** It resolves the initialiser:
   arrow and function expressions become `Function` nodes (verified directly
   against `parser.py:2590` on a 7-declaration fixture). What produces no node is
   a **call expression or an object literal**. The distinction matters because
   claudin is built almost entirely from the forms it misses — **476**
   `export const X = call(`, **293** `export const X = {`, against only **72**
   arrow forms — so the misses are `memoize(…)` and `buildTool({…})` wrappers, not
   the `export const` keyword. The defect is narrow and fixable rather than
   architectural, so do not cite it as an argument against tree-sitter graphs in
   general.
2. **The 203k tokens were response shaping, not traversal.** Their query is
   bounded and ranked, never a closure: `MAX_IMPACT_DEPTH = 2`,
   `MAX_IMPACT_NODES = 500` (`constants.py:43-44`), a weighted best-score
   relaxation (`graph.py:1351`). So the closure degeneracy measured in
   [[repo-map-graph-topology-degenerate]] **cannot be levelled at this tool** — an
   earlier version of that memory claimed it could, which was wrong. What actually
   happened: depth 2 on claudin already reaches ~2,013 nodes, hits the 500 cap, and
   the **default** `detail_level="standard"` (`tools/query.py:113`) emits 500 full
   node dicts plus edges plus impacted_files at ~1,628 chars/node. The `minimal`
   mode from kept-idea 3 above already returns a risk label, a count and 5 key
   entities — the shaping existed and the default did not use it. **Check the
   serialization before blaming the algorithm.**

Eval status, re-read: `impact_accuracy` was re-measured 2026-08-02 across 7 repos
and the CSV now self-labels its circular mode `graph-derived (circular — upper
bound)`, a real integrity improvement. Co-change is still **f1 = 0.0 on every row
of every repo**. `token_efficiency` has NOT been re-measured since 2026-05-25, so
"the graph loses 10–50×" stands unrevisited, and `agent_baseline` still publishes
nothing.

One anti-pattern to not copy: `hooks/session-start.sh` injects a **mandate** —
*"prefer using the code-review-graph MCP tools before scanning files manually…
Fall back to Grep/Glob/Read only when the graph does not cover what you need."*
That answers the adoption question by instruction rather than evidence, which is
the pattern claudin measured at zero adoption ([[tool-result-nudges-benched-zero-adoption]]).
Their staleness answer is worth noting though: a `PostToolUse` hook on
`Write|Edit|Bash` re-indexes synchronously with a 30 s timeout, plus a background
rebuild on `EnterWorktree` — it prices staleness honestly, as latency per edit.

Two more implementations of the same idea were audited the same day — see
`docs/tech/repo-map/prior-art.md` and [[code-graph-siblings-audited]].
