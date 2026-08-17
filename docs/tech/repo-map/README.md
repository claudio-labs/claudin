# Repo Map / Code Index — technical evaluation and design

> **Status:** measured on 2026-08-16 against this tree. The algorithm in
> proposal v1 (reference graph by identifier tokenization + global PageRank,
> injected into the prompt head) **does not rank this repository usefully** and
> is not implementable as specified. **Revised 2026-08-17: the one lane this doc
> kept alive is now withdrawn too** — see the follow-up below. Nothing here is
> recommended for implementation; the doc is kept as the measured record of why.
> **Branch:** `repo_index_map` — documentation and probe only, no `src/` changes.
> **Raw numbers and how to reproduce them:** [`measurements.md`](measurements.md),
> probe at [`scripts/bench/repomap/`](../../../scripts/bench/repomap/).
>
> **Follow-up:** the two-layer variant (static prefix tree + SQLite symbol graph)
> was proposed and measured separately — see
> [`two-layer-viability.md`](two-layer-viability.md). Camada 1 is off by ~70× on
> its token budget and replaces an artifact already 97.3% accurate; Camada 2's
> `impact_of` is a constant function on this topology — and so is the forward
> direction, which is what withdraws Lane A. What survives both studies is a
> **map verifier** that costs zero prompt tokens
> ([`two-layer-viability.md` §5](two-layer-viability.md#5-what-survives-verify-the-map-dont-generate-it)).
>
> **Prior art, 2026-08-17:** three sibling implementations were audited —
> [`prior-art.md`](prior-art.md). One of them **corrected this study**:
> bounded-depth traversal is not a closure, and at directed depth ≤2 it is not
> degenerate here, so Lane A is partially reinstated **without any ranking**.
> Four ideas are worth taking; none of the three publishes an honest measured win.

## 1. Why this doc exists

Two things had to be reconciled before writing a line of production code.

**The proposal.** A repo map in the spirit of [Aider](https://github.com/Aider-AI/aider):
a directed graph whose nodes are files and whose edges are references between
them, weighted by IDF, ranked by PageRank, rendered under a token budget, and
injected into the head of the context so the agent stops spending its first
3–8 tool calls guessing where things live. The proposal's central insight about
*this* codebase is correct and worth keeping: `src/tools/shared/codeOutline/`
already contains a dependency-free structural scanner, so the map needs no
tree-sitter and no new dependency — unlike `Gitlawb/openclaude`'s port, which
carries `graphology` plus tree-sitter grammars.

**The prior rejection.** The same feature was proposed and **rejected on
measured data on 2026-08-07** (team memory
`repo-map-rejected-orientation-measured`). That audit covered 503 local
transcripts (257 with main-thread tool calls, 21.4M `tool_result` chars) and
found: orientation is real in *time* (median 20 tool calls and 49.3k chars
before the first `Edit`, 32.3% of all `tool_result` chars) but almost none of it
is *locating* — inside that prefix `Read` is 64.6% and `Glob` is **0.3%**.
Discovery-shaped calls are **2.14%** of all chars, and the absolute ceiling,
assuming a map displaced every `Grep` too, is 5.4%. No static artifact reaches
the tail: **59.5%** of the 462 distinct paths read during orientation appear in
exactly one session. Leave-one-out, a static top-50 list covers 33.4% of
orientation reads. That memory ends with an explicit instruction: *do not
re-open the repo-map port without new measurement.*

This branch is that new measurement. §5 is what it found, and it is a second,
independent reason to not build the head-injected map — this time a property of
the algorithm rather than of the transcripts.

## 2. What claudin already provides

Verified, not assumed. Every row was read on 2026-08-16.

| Existing piece | Where | Reuse verdict |
|---|---|---|
| `scanSymbols(source, lang)` → ordered `SymbolEntry[]` | `src/tools/shared/codeOutline/scanSymbols.ts:94` | **Reuse as-is** for rendering signatures. Not for extraction — see §6. |
| `maskSourceForLang(source, lang, opts?)` → string with strings/comments blanked in place, same length, offsets preserved | `src/tools/shared/codeOutline/scanSymbols.ts:150` | **Reuse as-is.** Already public — proposal v1's Phase 0 change to `scanSymbols.ts` is unnecessary. |
| `detectOutlineLangFromPath(path)` → `OutlineLang \| null`, 32 languages | `src/tools/shared/codeOutline/detectLang.ts:101` | Reuse for enumeration. Worth 0.4% of this corpus (§5.1). |
| `renderOutline` signature rendering with elision | `src/tools/shared/codeOutline/renderOutline.ts` | Reuse the format, not the entry point. |
| `roughTokenCountEstimation(content, bytesPerToken?)` — calibrated to the active model | `src/shared/tokenEstimation.ts:261` | Reuse for the budget. |
| `execFileNoThrowWithCwd(file, args, {cwd, env, maxBuffer, timeout})` | `src/shared/proc/execFileNoThrow.ts:155` | Reuse for `git ls-files`. |
| `createTwoTierCache` (TTL + coalescing) | `src/tools/shared/twoTierCache.ts:102` | In-process layer only; disk layer is new. |
| `getClaudinConfigHomeDir()` | `src/shared/envUtils.ts` | Cache root. |
| `p-map` 7.0.6 | `package.json:117` | Already a dependency; batch the extraction pass. |

**No new dependency is needed.** That part of the proposal holds.

## 3. The v1 algorithm, restated

1. Enumerate with `git ls-files -z --cached --others --exclude-standard`; keep
   paths where `detectOutlineLangFromPath` is non-null.
2. Per file: defs from `scanSymbols`, plus a multiset of identifiers from a
   regex over the **masked** copy (`/[A-Za-z_$][A-Za-z0-9_$]*/g`, minimum length
   3, capped at 500 per file).
3. `defIndex: symbol name → set of defining files`.
4. Edge `A → B` when A's identifier multiset contains a name B defines; weight
   `Σ count_A(s) × idf(s)`, `idf(s) = ln(totalFiles / |defIndex[s]|)`, names on a
   ~70-entry common-name denylist penalised `× 0.1`, names defined in more than
   100 files dropped, self-edges dropped.
5. PageRank, `α = 0.85`, tolerance `1e-6` (L1), max 100 iterations, dangling
   mass redistributed through the teleport vector, focus expressed as a
   **personalization vector** rather than openclaude's post-hoc multiply
   (verified: `openclaude/src/context/repoMap/pagerank.ts` multiplies focus
   scores by 100 and neighbours by 10 *after* the solver returns, so the boost
   does not propagate).
6. Render top-down, definitions only, whole sections or nothing, `⋮` elision
   markers, budget from `roughTokenCountEstimation`.
7. Two cache tiers: per-file tags keyed by `mtime+size`, rendered map keyed by
   a hash of the inputs.
8. Inject at ~1024 tokens into the context head, built once per session and
   frozen so the prompt cache keeps it.

A faithful 1,267-line prototype of exactly this now lives in
[`scripts/bench/repomap/`](../../../scripts/bench/repomap/).

## 4. Measurement method

The prototype ran over the real tree (3,955 git paths) with a warm filesystem,
median of 3 after a discarded warm-up. It implements enumeration, mask +
`scanSymbols` extraction, the ident regex, the `defIndex`, the IDF graph with
both caps, CSR PageRank with dangling redistribution and personalization, and
the budgeted renderer. It also builds two controls the proposal does not
describe: an **import graph** (parse the actual `import`/`from` specifiers and
resolve them to repo files) and a **churn ranking** (`git log` over the last
2,000 commits). Full numbers in [`measurements.md`](measurements.md).

## 5. What it found

### 5.1 The corpus is one language

3,955 git paths, 3,711 eligible (93.8%), 29.6 MiB. **89.7% is TypeScript**
(3,327 files); markdown is 339 and everything else totals 45. Only 9 of the 32
`OutlineLang` values appear at all. The inherited 27-language coverage — the
proposal's headline advantage over openclaude's TS/JS/Python — is worth **0.4%**
of this repository. It is not wrong, it is just not a reason.

### 5.2 The cost is in the existing scanner, not the new code

A cold full pass is **3,053 ms**: 61 ms reading (2.0%), **2,692 ms mask +
`scanSymbols` (88.2%)**, 301 ms for the ident regex (9.9%), 174.5 MiB RSS. The
proposal's "sub-millisecond per file" is true of the new code (0.081 ms/file)
and false of the pass as a whole (0.82 ms/file). It lands **at** the proposal's
own `< 3 s` acceptance target with no margin, and 88% of that is a component
nobody would be optimising.

### 5.3 The identifier graph is dense and mostly noise

Of 1,170,381 identifier occurrences, **35.4%** resolve to a defining file and
become edge weight; 64.4% are dropped for having no definition anywhere in the
repo. The result is 3,711 nodes and **260,464 edges** — average out-degree 70.2,
density 1.9e-2. The two caps that were supposed to defend against this are
nearly inert: only **three** names exceed `MAX_DEFINITION_FANOUT = 100`
(`Props` 285, `_temp` 155, `call` 125), together 0.1% of occurrences.

### 5.4 The ranking fails its own sanity check, and not marginally

PageRank itself is fine — 32 iterations, 142 ms, score sum 1.000000000000. What
comes out is not. The top five files are
`src/agent/context/tokenAnalytics.ts`, `src/providers/model/bedrock.ts`,
`.github/workflows/release-binaries.yml`, and two `.test.ts` files. **19 of the
top 100 are tests.** The proposal's Phase-4 acceptance criterion — that
`src/agent/query.ts`, `src/tools/Tool.ts` and `src/agent/QueryEngine.ts` appear
at the top — lands at `query.ts` **#567**, `Tool.ts` #138, `context.ts` #505.

The cause is measurable and was verified independently of the probe:
`TokenUsageTracker` declares methods named `export()` and `import()`
(`src/agent/context/tokenAnalytics.ts:196,203`), and `scanSymbols` correctly
reports both as `kind=method` defs. Every TypeScript file in the repo contains
dozens of `import` and `export` tokens, which the string/comment mask does not
remove because they are code. Of the 276,847 inbound weight units that put that
file at #1, `import` contributes 177,634 and `export` 94,749 — **98.4% from two
language keywords.**

The proposal anticipates this with a per-language `KEYWORDS` denylist, so the
probe added it. It is **mandatory, not polish** — but it does not rescue the
ranking, it flattens it: the ratio between the first and second score collapses
from 2.77× to **1.04×**, which is another way of writing "no discrimination".
Restricting to top-level defs raises test-file contamination to 38 of the top
100. Four variants were measured; none is usable
([`measurements.md`](measurements.md) §5).

### 5.5 The control isolates the fault — and then fails too

PageRank over the **real import graph** (24,103 specifiers parsed, 19,051
resolved to repo files = 79.0%; 3,349 nodes, 18,217 edges, **12× sparser**; 22
iterations, 11 ms) produces a coherent result: `state.ts`, `debug.ts`, `log.ts`,
`ink.ts`, `envUtils.ts`, `errors.ts`, `config.ts`, `Tool.ts` at #11 — and **zero
test files in the top 100**. So the broken component is the identifier-
tokenization reference extractor, not PageRank, and not IDF.

But the control also ranks `query.ts` **#1,634** and `QueryEngine.ts` #1,176.
Those files import a great deal and are imported by almost nothing. **PageRank
ranks sinks, not roots** — the leaf utilities everything depends on. No
import-based centrality can satisfy the proposal's acceptance criterion, which
means the criterion was wrong about what the algorithm computes.

### 5.6 Centrality is not what people edit

The decisive number. Against file churn over the last 2,000 commits:

| overlap with churn top-N | import-graph centrality |
|---|---|
| top-10 | 0 / 10 |
| top-25 | 0 / 25 |
| top-50 | 0 / 50 |
| top-100 | 1 / 100 |
| top-200 | 5 / 200 |

Spearman ρ = **−0.104** (n = 3,349) — slightly *negative*. Central files are
stable leaf utilities (`log.ts`, `debug.ts`); churn lives in
`FileReadTool.ts` (27 commits), `BashTool.tsx` (22), `AgentTool.tsx` (19).

This is the 2026-08-07 audit's "no task→location signal" reproduced from a third
direction, and it is the finding that decides the design: a centrality-ranked
map, however well implemented, ranks the files a task is *least* likely to
touch.

## 6. Component verdicts

| Component | Verdict |
|---|---|
| `git ls-files -z` enumeration | **Keep.** Works, respects `.gitignore`, one call. |
| Reuse of `maskSourceForLang` | **Keep.** Already public; no change to `codeOutline` needed. |
| Refs by identifier tokenization | **Reject.** 64.4% of occurrences resolve to nothing, 98.4% of the winning file's weight came from two keywords, and the fix flattens the ranking to 1.04× (§5.3–5.4). |
| IDF weighting + fanout cap | **Keep, but it is not load-bearing.** Only 3 names exceed the cap here. |
| Common-name denylist at `× 0.1` | **Necessary but insufficient.** Worth keeping the dedicated test the proposal asks for; it is not what makes a map work. |
| PageRank (α 0.85, dangling via teleport, personalization vector) | **Keep the implementation, drop the global product.** The math is correct and converges in 22–32 iterations; the personalization-vector choice over openclaude's post-hoc boost is right. |
| Global centrality ranking as the map's order | **Reject** (§5.6, ρ = −0.104). |
| Budgeted renderer, whole-sections-only, `⋮` markers | **Keep.** Deterministic and byte-stable ([`measurements.md`](measurements.md) §7). |
| Two-tier cache keyed on `mtime+size` | **Keep**, with one change: see §8. |
| Head injection into `getUserContext` | **Reject as designed** — wrong lane, see §9.1. |
| 27-language coverage as a selling point | **Drop.** 0.4% of this corpus. |

## 7. Corrections to proposal v1

| v1 claim | Measured reality |
|---|---|
| Phase 0 must modify `scanSymbols.ts` to expose the masked copy | `maskSourceForLang` is already public at `scanSymbols.ts:150`. No change needed. |
| `src/vcs/git/git.ts` already sanitises `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` | It does not. No such sanitisation exists anywhere in `src/`. The env must be scrubbed in the new enumerator. |
| "Sub-millisecond per file" | 0.081 ms/file for the new regex; 0.82 ms/file for the pass. Cold build 3,053 ms against a `< 3 s` target. |
| Language breadth is the advantage over openclaude | Worth 0.4% of this corpus; 89.7% is TypeScript. |
| `MAX_DEFINITION_FANOUT` cuts the pathological case | Three names exceed it (0.1% of occurrences). The pathological case was two *keywords*, which no fanout cap catches. |
| Acceptance: `query.ts`, `Tool.ts`, `QueryEngine.ts` at the top | Unreachable by any import- or reference-based centrality: those are graph roots, and PageRank ranks sinks. Best observed `query.ts` position across five variants: **#550 of 3,711**. |
| A byte-stable block in the head rides the frozen prefix at 0.1× | Half true, and the wrong pattern here — the two large head keys were deliberately *removed* from that lane (§9.1). |
| The map "answers where things live with no tool call" | The 2026-08-07 audit measured the addressable share of orientation at 2.14% of chars (5.4% ceiling), with 59.5% of read paths appearing in exactly one session. |

## 8. Revised design — three lanes

### Lane A — focused dependency neighbourhood, on demand, as a tool → ~~build behind a flag~~ **withdrawn**

What survives measurement is not a *map* but a *query*. The import graph is
cheap (11 ms to rank, 18k edges), resolves 79% of specifiers, and carries no
test-file contamination; and the personalization vector makes "what is
structurally near X" propagate through the graph instead of stopping at direct
neighbours. That is a different product from a global map:

- Input is a **required** focus — files, directories, or symbols. There is no
  global mode, because §5.6 says a global order is anti-correlated with what
  the caller is about to touch.
- Output is the focus's ranked neighbourhood rendered as budgeted definition
  signatures, so one call replaces a chain of grep-for-importers plus several
  outline reads.
- References come from **import specifiers**, not identifier tokenization.
  Resolution must handle this repo's conventions: the `src/…` alias from
  `tsconfig.json`, `.js` specifiers pointing at `.ts`/`.tsx` sources, and the
  fork's deliberately-relative imports of `.d.ts`-only modules
  (`.claudin/rules/build-system.md`).
- **Definitions are scanned on demand**, only for the files that make the
  budget — not for the whole tree. This is the one design change that follows
  directly from §5.2, where 88.2% of the cold pass was mask + `scanSymbols`
  over 3,711 files to render ~20 of them. Caveat: the probe timed mask and
  `scanSymbols` *together*, so the split between them is **unmeasured**, and the
  size of this win is therefore unknown. Phase 0 measures it before the design
  leans on it.

Lane A is a **hypothesis with a defined A/B** (§11), not a decided build. It is
plausible that `Grep` plus an outline read already covers it at lower cost; that
is exactly what the gate is for.

> **WITHDRAWN 2026-08-17.** Everything above was written before the closure sizes
> were measured, and they remove the query.
> [`two-layer-viability.md` §4.1 and §4.5](two-layer-viability.md#45-both-directions-are-degenerate--the-graph-is-one-giant-core)
> show the import graph is one giant strongly-connected core: the transitive
> closure is ~2,462 files in the reverse direction and ~2,361 forward, with p50,
> p90 and p99 equal in both, and only 50 distinct forward closure sizes across
> 3,360 files. A "focused neighbourhood" is therefore either the whole core
> (~22–24k tokens, identical for every file an agent edits) or the direct edges
> (forward p50 3, reverse p50 1) — which is one `Grep`. There is nothing in
> between on this graph, so the personalization vector has nothing to
> discriminate. Phases 1–5 and the flag are not worth writing. Kept in place
> because the reasoning that led here is the useful part.
>
> **PARTIALLY REINSTATED, same day.** The withdrawal above is right about
> closures and wrong about neighbourhoods, which are not the same query.
> [`prior-art.md` §2](prior-art.md#2-the-correction--bounded-depth-is-not-a-closure)
> measures bounded depth: **directed depth 2 gives 272–286 distinct answer sizes,
> p50 6–22 files, p90 ~1k tokens** — informative, and not one `Grep`. The collapse
> into the core is at *undirected* depth 3. So what stays dead is the **ranking**
> — PageRank, betweenness, the personalization vector — and what survives is a
> neighbourhood where **depth is the budget and there is no ranking at all**. That
> is a much smaller build than the one designed above: no `pagerank.ts`, no focus
> vector, no score tie-break. Gate 1 (§11) still decides it and is still
> unmeasured.

### Lane B — global map injected into the prompt head → **do not build**

Rejected twice over: no ranking signal (§5.4–5.6) and the wrong cache lane
(§9.1). Reopening it needs a *new* ranking function that has been measured
against churn or against real transcripts, not a better implementation of this
one.

### Lane C — churn + recency list → **documented, not built**

If head injection is ever revisited, the ranking with a measured relationship to
what people edit is churn, not centrality — and it costs one `git log`, no
graph, no scanner, no cache. Its ceiling is also already known: the 2026-08-07
leave-one-out analysis puts a static top-50 at 33.4% of orientation reads
(~623 tokens) and a top-200 at 61.1% (~2.5k tokens). Recorded here so the next
proposal starts from these numbers instead of re-deriving them.

## 9. Constraints that bind whatever ships

### 9.1 The prompt-cache lane

`appendSystemContext` (`src/providers/transport/api.ts:499`) sorts keys
specifically so a rebuild cannot reorder them — *"byte-identity required for
implicit prefix caching in OpenAI/Kimi/DeepSeek and for Anthropic
`cache_control` breakpoints"*. It pushes to the **end** of the block array, past
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`api.ts:424`), i.e. onto the **uncached**
side. `userContext` goes somewhere else again: into `messages[0]` via
`prependUserContext` (`api.ts:516`).

The decisive precedent is that the two large head keys are **filtered out of
that lane on purpose**. `STATIC_DEDUP_CONTEXT_KEYS` (`api.ts:554`) strips
`claudeMd` and `gitStatus` from `appendSystemContext`, and
`src/vcs/git/gitStatusDelta.ts:33` explains why: re-appending a snapshot to
every system prompt costs bytes on every request for content that cannot
change, so it is emitted **once on turn 1 as an attachment**. Meanwhile
`currentDate` is deliberately allowed to go stale
(`src/agent/attachments/injections.ts:77`) because refreshing it would turn a
whole overnight conversation into `cache_creation` — *"~920K effective tokens per
midnight crossing"*.

So a repo-map block must not be a new `getUserContext` key. If Lane B is ever
revived, the shipped pattern for exactly this shape of content is a turn-1
attachment with its own `*_CONTEXT_KEY` in `STATIC_DEDUP_CONTEXT_KEYS`. Both
builders memoize with **no key function** (`src/agent/context.ts:116,155`) — one
entry per process, cwd *not* part of the key, the same trap `getMemoryFiles`
has.

### 9.2 Cold start

`bun run profile:cold-start` (`scripts/bench/perf/cold-start-bench.ts`) times
`node dist/cli.mjs --version` against `--help`. Recorded baseline: ~525 ms
direct, ~282 ms with `NODE_COMPILE_CACHE`, *"dominated by V8 parse of the 21 MB
bundle, not Node boot"* (`scripts/bench/perf/README.md:16`). A statically
imported module is therefore paid in the parse of both arms and does **not**
show up in the `--help − --version` delta — the honest signals are bundle bytes
and the `--version` p50. Laziness in this tree lives in the registry, not in the
tool: `src/tools/tools.ts:37` uses a `require`-returning accessor, and
`src/__tests__/lazyToolImports.test.ts` pins, per tool, the exact set of files
allowed to value-import it.

### 9.3 Tool-description immutability

`src/tools/TypecheckTool/prompt.ts:1` states the rule the new tool inherits:
the description is part of the shared system prompt, so *"interpolating anything
environment-derived here would fragment the prompt cache for every user …
Detection results belong in the tool RESULT, never here."* File counts,
languages found, graph size, build time: all in the result. Pin the length with
a `prompt.test.ts` the way `src/tools/GitTool/prompt.test.ts:10` does.

### 9.4 The `outputSchema` trap

`UserToolSuccessMessage.tsx` renders what `outputSchema` *parses*, and
`z.object` drops undeclared keys — so a metric the renderer reads but the schema
omits silently arrives as `undefined` in the TUI only. `BuildTool` shipped that
way. Pin every metric with an `outputSchema.parse(result)` test
(`src/tools/BuildTool/BuildTool.test.ts:244`).

### 9.5 Fail-open

`codeOutline`'s convention: any internal error, unbalanced source, or zero
symbols yields `[]` and the caller degrades. Same here — no git, no supported
file, corrupt cache, non-convergence: return an empty result, never throw. Cache
writes are fail-silent so a read-only home makes the index slower, not broken.

### 9.6 Placement and imports

`src/tools/shared/repoMap/` (engine, beside `codeOutline/` and `outputFilter/`)
and `src/tools/RepoIndexTool/` (the tool). `src/__tests__/moduleBoundaries.test.ts`
bans only the seven retired top-level buckets, so both are fine; the binding
rule is its third test — every **cross-slice** import must use the `src/…`
alias, so reaching into `src/shared/…` or `src/vcs/…` with `../` fails.

### 9.7 The feature flag

Add `REPO_INDEX: false` to `featureFlags` (`scripts/build/build.ts:22`).
`feature('X')` must sit **directly** in an `if` or ternary condition — any other
form throws *"feature() from \"bun:bundle\" can only be used directly in an if
statement or ternary condition"* under `bun test` and never under
`bun run build`, which folds it to a literal. Note also that
`src/stubs/test-preload.ts` makes every flag read `false` under `bun test`, so
the engine's tests must import the engine directly rather than through the gate.

## 10. Phases

> **Superseded 2026-08-17.** These phases implement Lane A, which §8 withdraws.
> They are kept because Phase 0's two questions were the right ones to ask first —
> and asking them is what produced the closure measurement that cancelled the rest.

Each phase is one PR, all behind `feature('REPO_INDEX')` = `false`. Phases 0–1
are cheap and answer the questions the design still has; **Phase 4 decides
whether 2–5 are worth writing.**

| # | Content | Depends on |
|---|---|---|
| 0 | Split the mask/`scanSymbols` timing (§8), and measure import-specifier resolution: what the 21% unresolved consists of, and whether skipping the mask produces false edges from commented-out imports | — |
| 1 | `importGraph.ts` — enumeration with a scrubbed git env, specifier extraction, alias/`.js`→`.ts` resolution, sparse adjacency | 0 |
| 2 | `pagerank.ts` — CSR power iteration, dangling mass through the teleport vector, personalization, path tie-break | 1 |
| 3 | `renderNeighbourhood.ts` — defs scanned on demand for budgeted files only, whole sections, `⋮` markers, per-file `mtime+size` cache | 2 |
| 4 | **A/B gate** (§11) — measured before the tool surface exists, driving the engine directly | 3 |
| 5 | `RepoIndexTool` + `/repoindex`, only if Phase 4 passes | 4 |

## 11. Acceptance gates

Nothing here is negotiable by inspection; `scripts/bench/perf/README.md` exists
because repeated rounds of performance optimisation by code inspection were
disproven when somebody finally measured.

**Gate 0 — the ranking is not noise.** For a focus on a known subsystem, the
returned neighbourhood must be dominated by that subsystem's real dependencies,
with **no test files** unless the focus is a test, and the first/second score
ratio must not collapse to ~1.0 the way §5.4 did. Pinned as a fixture test over
this repo.

**Gate 1 — it beats the alternative.** A/B over ≥20 tasks against the existing
path (`Grep` for importers plus outline reads), following
`scripts/bench/ab/cache-lockstep-bench.ts`'s method — one turn per file via
`--input-format stream-json`, identical pacing, N ≥ 3, median, alternating arm
order:

| Metric | Target |
|---|---|
| Tool calls before the first `Edit` | −30% |
| Total tokens per task | ≤ baseline |
| Cache read ratio | no regression |
| Cold start (`--version` p50, bundle bytes) | no regression above noise |
| Cold index build | < 1 s (import-only pass; the 3 s number was the def-heavy pass) |
| Warm build | < 100 ms |

**Gate 2 — determinism.** Two builds over the same tree produce byte-identical
output, including tie-breaks. The probe measured 905 exact float score ties out
of 3,711 nodes (0 inside the top 200), so the path tie-break is required for a
total order even though it does not currently change what renders.

Failing Gate 0 or 1 means the flag stays off and the branch is not merged. That
is the outcome the branch exists to make cheap.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Lane A is also just re-deriving what `Grep` already answers | Gate 1 is exactly this question, measured before the tool surface is built |
| Import resolution misses the 21% and the graph quietly loses a subsystem | Phase 0 characterises the unresolved set before anything is built on it |
| Defs-on-demand does not actually save the 88% | Phase 0 splits the timing first; if mask dominates, the saving evaporates and Phase 3 changes shape |
| Someone deletes the common-name denylist as redundant with IDF | Dedicated test naming the `× 0.1` factor, as proposal v1 asks — the measured 1.04× collapse is why it is not redundant |
| The index grows a head-injection path by accretion | §9.1 is the reason it cannot be a `getUserContext` key; Lane B stays rejected in writing |
| Numbers here rot | The probe is committed at `scripts/bench/repomap/`; re-run it rather than trusting this doc |

## 13. Attribution and references

The design — reference graph, IDF weighting, PageRank over files, token-budgeted
render, `mtime+size` cache — is **Aider**'s (Paul Gauthier, MIT).
`Gitlawb/openclaude`'s `src/context/repoMap/` is a port of it using tree-sitter
tag queries plus `graphology`; this evaluation borrows the algorithm only and
ports no queries. Keep the attribution in the header of any graph or PageRank
module that ships.

- [`measurements.md`](measurements.md) — the numbers, in full
- [`two-layer-viability.md`](two-layer-viability.md) — the two-layer variant, measured
- [`prior-art.md`](prior-art.md) — three sibling implementations audited; the bounded-depth correction
- [`scripts/bench/repomap/`](../../../scripts/bench/repomap/) — the probe
- `.claudin/memory/team/repo-map-rejected-orientation-measured.md` — the 2026-08-07 audit
- `.claudin/memory/team/dev-tooling-token-roadmap.md` — where the tokens actually are (`Read` at 59.7% of tool-result chars)
- `docs/tech/cache/clip-frontier-breakpoint.md`, `src/agent/cache/README.md` — the cache invariant
- `.claudin/rules/cache.md`, `.claudin/rules/code-design.md`, `.claudin/rules/testing.md`
- `scripts/bench/perf/README.md`, `scripts/bench/ab/cache-lockstep-bench.ts` — bench method
