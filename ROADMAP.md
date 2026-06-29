# Token-Efficiency Roadmap

Ranked build/skip verdicts for token-saving features (tool-result compression,
output reduction, failure-learning, memory, dashboards). Each verdict is
grounded against the real codebase, not generic advice — the point is to record
*why* several plausible-sounding features are not worth building so we don't
relitigate them.

**How to use it:** when picking the next token-efficiency task, start at the top
of the BUILD list. If asked to build a SKIP item, surface the recorded reason
first.

---

## Shipped

| # | Feature | Where | Result |
|---|---------|-------|--------|
| 1 | Statistical JSON/array compression in tool results | `src/utils/jsonArrayCompress.ts`, wired via `src/utils/toolResultSummarizer.ts` (`dispatch`/`maybeJsonStructural`); flag `TOOL_RESULT_JSON_COMPRESSION`, default-on | cW −36%, cost −13% on a 30-turn Sonnet run, no per-turn cache-write spike |
| 2 | Reversible compression backing ("CCR") | `src/utils/toolResultStorage.ts` persists the full JSON-lines canonical form; omitted rows stay retrievable via Read/Grep on the cited path | Delivered with #1 — a bespoke retrieve tool would only *add* schema tokens |
| 3 | "Context tokens saved" line in `/usage` | `src/utils/tokensSaved.ts` accumulator → `/usage` Session tab | Shows real per-session savings |
| 4 | Verbosity steering (answer-length ceiling) | `getVerbositySection()` in `prompts.ts`, dynamic section after the cache boundary; default-on, opt-out `CLAUDIN_VERBOSITY_STEERING=0` | −26% prose chars with no loss of answer cores (runs=1; runs=3 median pending) |
| 5 | Repeated-error loop → memory-extraction trigger | `src/services/extractMemories/loopDetector.ts`, wired into `extractMemories.ts`; flag `LOOP_ERROR_MEMORY_TRIGGER`, opt-out `CLAUDIN_LOOP_MEMORY_TRIGGER=0` | Fires a `feedback` memory on a ≥3× same-tool error loop; runtime-verified, zero false memories |
| 7 | Constant-field hoisting (SmartCrusher batch) | `constantFields()` + `const=` line in `src/utils/jsonArrayCompress.ts`; rides the `TOOL_RESULT_JSON_COMPRESSION` flag | Lossless: fields identical on every row hoisted out of the grid. −21.5% render chars on the `big-json.sh` fixture (`author` + `labels`); backing `jsonl` unchanged |

---

## Planned — SmartCrusher batch

Enhancements to the existing `jsonArrayCompress.ts` JSON compressor. Today it is
purely **structural/positional**: it factors repeated keys into a header and,
once an array passes 60 elements, drops a *fixed* window (40 head + 10 tail,
`jsonArrayCompress.ts:21-23`) — discarding the middle blindly. These items add a
content-aware selection layer on top.

### Integration facts (constrain every implementation here)

- **Call sites:** `compressJsonArray` runs only in `toolResultSummarizer.ts`
  (`dispatch`, Bash output ≥ 8 KB) and via `maybeJsonStructural` (Agent/MCP
  array content ≥ 8 KB). The **input universe is JSON emitted by shell commands**
  (`gh … --json`, `kubectl get -o json`, `npm audit --json`, `aws`, test-runner
  `--json`) plus MCP JSON — not arbitrary text.
- **No query/context at the call site.** `maybeSummarizeToolResult(block,
  toolName)` is pure and stateless, and the module must stay
  ink-free / bun-test-loadable. This is why relevance / BM25 / query-anchor
  pinning is out of scope here (see Won't build).
- **Reversibility is by index, not by keep-set.** The persisted backing is the
  *full* array, one element per line aligned to the marker's `#N`
  (`toolResultStorage.ts:316-317`); retrieval is Read offset/limit + Grep on the
  filepath. So **which rows we render is independent of recoverability** —
  changing the keep-set never makes a row unrecoverable. This de-risks
  content-aware selection entirely.
- **The volume win is already captured.** The dumb head/tail window already nets
  ~7.5% median cost ($0.64 → $0.59 on a 20-turn run, $0.99 → $0.86 on 30 turns;
  see `scripts/profile/json-compression-*.txt`). So this batch is mostly a
  **correctness** win — stop dropping the salient row, which today forces the
  model into a Read-back round-trip — not raw volume.

### 6. Content-aware salient-row preservation — effort M

Replace the blind middle-drop with a `keep`-set that always pins the rows that
matter, then fills the rest with head/tail up to a budget.

- **High payoff (build first):** error-keyword rows and rare-status-value rows —
  in shell JSON the failed run / unhealthy pod / HTTP 500 / vulnerable package is
  usually scattered in the dropped middle.
- **Bonus:** structural outliers (rows with a rare field-set) and numeric
  anomalies (> N·σ from the per-field mean).
- **Defer:** change-points (time-series only — low hit-rate for our inputs).
- **Sub-part:** a unified keep budget = union of (head/tail + salient rows),
  capped — a simplified split, *not* a full knee-detection/optimal-k routine.
- Needs a minimal per-field stats subset (type, unique-ratio, is-constant,
  numeric mean/variance). Pure-statistical, no query, no native dependency —
  fits the module constraints; reversibility is unaffected (index-based).
- **Before shipping:** extend the `json-compression-bench` fixture with a
  "salient-row-in-the-middle" case to prove the correctness gain empirically —
  the real-world hit-rate is currently unmeasured.

### 7. Constant-field hoisting — ✅ SHIPPED (see Shipped table above)

Done as its own `const={…}` line (kept distinct from the wrapper `meta=`), not
merged into the preamble. `constantFields()` in `jsonArrayCompress.ts` splits the
union keys into constants (own-prop present + equal on every element) and varying
keys; a stray non-object element disables hoisting. All-constant arrays collapse
to `const=… / rows=N (all identical)` with the per-row grid dropped.

#6 still sits behind the existing tool-result marker, which is already placed
behind the prompt-cache clip frontier — so it does not risk cache reuse (#7 the
same).

---

## Deferred

- **Lossless-first compaction** (CSV+schema formatter, dotted-column flattening
  of nested-uniform objects, stringified-JSON-cell sub-tables). Real volume
  upside on nested `gh`/`aws` JSON, but it is a larger rewrite of the renderer
  and our flat tab-grid already captures the bulk. Revisit after #6 + #7 land.
- **Code compression via `scanSymbols.ts`** (regex symbol outline, TS/JS/Py/Go) —
  ~80% of the value of a tree-sitter approach at effort S.
- Follow-ups on shipped items: project-aggregate persistence of tokens-saved
  (#3), a runs=3 median A/B to pin the #4 magnitude, and tuning the 50 KB
  persistence threshold / compression aggressiveness (#2).

---

## Won't build (with reasons)

- **Code compression with tree-sitter** — no tree-sitter dependency; WASM +
  grammars fight the single-file bundle. Use `scanSymbols.ts` instead.
- **ML prose compression (ONNX model in the bundle)** — exactly what the repo
  rejects.
- **Effort routing** (lower reasoning on mechanical turns) — per-turn effort is
  only dynamic on the Anthropic path; the OpenAI shim binds reasoning effort at
  construction. Misclassifying an error/failed-test turn would dumb down the
  analysis.
- **Semantic / vector memory (HNSW)** — false premise: retrieval is already
  LLM-ranked (`findRelevantMemories.ts`), scale is tiny (vectors pay off at
  10k+ docs), native deps are bundle-stubbed, and embeddings would need a
  phone-home call (privacy conflict).
- **Cross-agent memory** (share with other CLIs) — scope creep; the shared
  `team/` memory dir already covers the real case.
- **Relevance context fitting / BM25 + embeddings** — conflicts with the cache
  (per-turn relevance reorder breaks the clip frontier and invalidates the
  prefix). At the JSON-compressor call site specifically it is also blocked:
  there is no query/context there, and threading the user's turn down through the
  summarizer fights its pure/bun-loadable design.
- **Field-role detection (ID/score) for JSON compression** — score-fields only
  feed a top-N ranking strategy (rare in shell JSON); ID-fields only feed a
  crushability decision tree we don't need given index-based reversibility.
- **Full crushability decision tree** — its purpose is avoiding *irrecoverable*
  lossy drops; here every drop is already recoverable, so the tree is moot. Only
  the "don't sample a high-uniqueness unique-entity array" heuristic is worth
  folding into #6.
- **Pattern classifier + per-pattern strategy** — the only useful sub-strategy is
  cluster-dedup for repetitive log arrays, which overlaps the existing Bash
  `collapseIdenticalRuns` / `collapseDigitTemplates`.
- **Image compression** — already exists (`sharp` + `imageResizer.ts`: dimension
  cap + JPEG quality ladder). An ML version is overkill for a cold path.
- **Live dashboard with confidence intervals** — without measured ground-truth
  the intervals are fabricated precision; the correct form is the `/usage` line
  (#3).

---

## Cross-cutting invariant

Any tool-result marker/stub MUST sit **behind the prompt-cache clip frontier**,
or it invalidates the cached prefix and breaks cache reuse. This applies to every
item above.
