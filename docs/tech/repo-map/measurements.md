# Repo map — measurements

Everything the [evaluation](README.md) cites. Run on 2026-08-16 against this
repository at `9551b0b9` (branch `repo_index_map`), warm filesystem, median of 3
after a discarded warm-up pass, on Linux 6.18 / Bun 1.3.11.

The probe is committed at [`scripts/bench/repomap/`](../../../scripts/bench/repomap/)
— re-run it rather than trusting these numbers. It is a 1,267-line faithful
implementation of proposal v1 plus two controls, deliberately kept out of `src/`.

**§8 was added on 2026-08-17** by probes `11`–`13`, which reprice the bounded-depth
neighbourhood in the unit the product would actually emit. The corpus grew
between the two runs (3,349 → 3,364 module files), so §1–§7 and §8 are minutes
apart in method and a day apart in corpus; the drift is under 0.5% and is called
out where it matters.

## 1. Corpus

`git ls-files -z --cached --others --exclude-standard` at the repo root.

| metric | value |
|---|---|
| total git paths | 3,955 |
| eligible (`detectOutlineLangFromPath` ≠ null) | 3,711 (93.8%) |
| eligible bytes | 31,013,386 (29.6 MiB) |
| `src/` eligible | 3,204 files, 25.3 MiB |

| lang | files | bytes |
|---|---|---|
| typescript | 3,327 | 28,114,891 |
| markdown | 339 | 2,757,158 |
| javascript | 22 | 21,554 |
| python | 9 | 46,327 |
| yaml | 6 | 27,403 |
| bash | 5 | 27,568 |
| env | 1 | 17,209 |
| dockerfile | 1 | 1,086 |
| toml | 1 | 190 |

9 of the 32 `OutlineLang` values appear; 89.7% of eligible files are TypeScript.

## 2. Mask availability

25 of 32 languages return a masked string from `maskSourceForLang`. Seven return
`null`: `markdown`, `yaml`, `properties`, `env`, `toml`, `dockerfile`,
`makefile`. So 350 of 3,711 eligible files (9.4%, almost all markdown) can
contribute **definitions but no references** — they enter the graph as pure
sinks.

## 3. Extraction cost

| metric | all (3,711 files) | `src/` only (3,204) |
|---|---|---|
| total | **3,053 ms** | 2,460 ms |
| read | 61 ms (2.0%) | 52 ms |
| mask + `scanSymbols` | **2,692 ms (88.2%)** | 2,111 ms |
| ident regex | 301 ms (9.9%) | 293 ms |
| RSS delta | 174.5 MiB | 87.8 MiB |
| def symbols | 30,963 | 25,430 |
| distinct identifiers | 51,746 | 49,134 |
| identifier occurrences | 1,170,381 | 1,093,833 |
| files above 500 distinct idents | 14 | 14 |

Per file: 0.081 ms for the ident regex, 0.73 ms for mask + `scanSymbols`, 0.82 ms
for the pass. `MAX_IDENTS_PER_FILE = 500` would affect 14 files.

**Known gap:** mask and `scanSymbols` were timed as one step. The split between
them is unmeasured, which is why the "defs on demand" saving in
[README §8](README.md#lane-a--focused-dependency-neighbourhood-on-demand-as-a-tool--build-behind-a-flag)
is stated as unknown in size.

## 4. Definition fanout and edge yield

| fanout (files defining the name) | names | share |
|---|---|---|
| 1 | 22,130 | 92.40% |
| 2–5 | 1,602 | 6.69% |
| 6–20 | 172 | 0.72% |
| 21–100 | 43 | 0.18% |
| > 100 | 3 | 0.01% |

The only names above `MAX_DEFINITION_FANOUT = 100`: `Props` (285), `_temp`
(155), `call` (125).

Identifier occurrences, by fate:

| fate | occurrences | share |
|---|---|---|
| became edge weight | 414,760 | 35.4% |
| dropped — defined nowhere in the repo | 754,223 | 64.4% |
| dropped by the fanout cap | 1,398 | 0.1% |

Resulting graph: 3,711 nodes, **260,464 edges**, average out-degree 70.2,
density 1.892e-2, 351 dangling nodes (9.5%). Build time 173 ms.

## 5. Ranking

PageRank: α 0.85, L1 tolerance 1e-6, max 100 iterations, dangling mass
redistributed through the teleport vector. Converged in **32 iterations /
142 ms**, score sum 1.000000000000.

Top 5 (v1, no keyword denylist):

1. `src/agent/context/tokenAnalytics.ts`
2. `src/providers/model/bedrock.ts`
3. `.github/workflows/release-binaries.yml`
4. `…/auth-code-listener.analytics.test.ts`
5. `…/Tool.types.test.ts`

19 of the top 100 are `.test.ts` (tests are 16.7% of the corpus).

### Why #1 is #1

`TokenUsageTracker` declares methods named `export()` and `import()`
(`src/agent/context/tokenAnalytics.ts:196,203`). `scanSymbols` reports both as
`kind=method` defs — verified independently of the probe:

```
$ bun -e "…scanSymbols(read('src/agent/context/tokenAnalytics.ts'),'typescript')…"
total defs: 13
export kind=method depth=1 line=196
import kind=method depth=1 line=203
```

Fanout 2 → idf 7.52. Every TypeScript file contains dozens of `import` and
`export` tokens, and the string/comment mask does not remove them because they
are code. Of the 276,847 inbound weight units behind that file's #1 position,
`import` contributes 177,634 and `export` 94,749 — **98.4% from two keywords.**

### Variants

| variant | edges | avg out | score₁/score₂ | tests in top 100 | `query.ts` | `Tool.ts` | `context.ts` |
|---|---|---|---|---|---|---|---|
| V1 no keyword filter | 260,464 | 70.2 | 2.77× | 19 | #567 | #138 | #505 |
| V2 + keyword denylist | 238,297 | 64.2 | **1.04×** | 18 | #571 | #95 | #504 |
| V3 + top-level defs only | 136,713 | 36.8 | 1.13× | **38** | #553 | #86 | #1,417 |
| V4 + drop null-mask langs | 132,558 | 39.4 | 1.13× | 38 | #550 | #84 | #1,409 |

The keyword denylist is mandatory — it removes the pathological concentration —
but it replaces it with no discrimination at all (1.04× between first and
second). Restricting to top-level defs doubles test contamination.

### V5 — the import-graph control

Parse real `import`/`from` specifiers and resolve them to repo files:

| metric | value |
|---|---|
| specifiers parsed | 24,103 |
| resolved to a repo file | 19,051 (79.0%) |
| nodes / edges | 3,349 / 18,217 |
| density | 1.625e-3 (**12× sparser** than V1) |
| iterations / time | 22 / 11 ms |
| test files in top 100 | **0** |

Top: `state.ts`, `debug.ts`, `slowOperations.ts`, `log.ts`, `ink.ts`,
`envUtils.ts`, `errors.ts`, `config.ts`, then `Tool.ts` (#11) and
`activeProvider.ts` (#12).

This isolates the fault to the identifier-tokenization extractor. It does **not**
rescue the proposal's acceptance criterion: V5 ranks `query.ts` #1,634,
`QueryEngine.ts` #1,176, `context.ts` #739. PageRank ranks depended-upon leaves,
and those three files are graph roots.

## 6. Centrality vs churn

Churn = commits touching each file over the last 2,000 commits. Centrality =
V5 import-graph PageRank.

| overlap | value |
|---|---|
| top-10 | 0 / 10 (0%) |
| top-25 | 0 / 25 (0%) |
| top-50 | 0 / 50 (0%) |
| top-100 | 1 / 100 (1%) |
| top-200 | 5 / 200 (3%) |

Spearman ρ = **−0.1041** (n = 3,349).

The two lists side by side, which is the whole argument in one table:

| # | by import-graph centrality | by churn (commits) |
|---|---|---|
| 1 | `src/platform/bootstrap/state.ts` | `src/tools/FileReadTool/FileReadTool.ts` (27) |
| 2 | `src/shared/debug.ts` | `src/tools/BashTool/BashTool.tsx` (22) |
| 3 | `src/platform/slowOperations.ts` | `src/tools/AgentTool/AgentTool.tsx` (19) |
| 4 | `src/shared/log.ts` | `src/tools/FileReadTool/prompt.ts` (16) |
| 5 | `src/terminal/ink.ts` | `src/tools/FileReadTool/FileReadTool.test.ts` (15) |
| 6 | `src/shared/envUtils.ts` | `src/__tests__/lazyToolModuleLoad.test.ts` (14) |
| 7 | `src/shared/errors.ts` | `src/tools/BashTool/prompt.ts` (14) |
| 8 | `src/platform/config/config.ts` | `src/tools/GrepTool/GrepTool.ts` (13) |
| 9 | `src/shared/data/lazySchema.ts` | `src/tools/AgentTool/UI.tsx` (12) |
| 10 | `src/shared/fs/fsOperations.ts` | `src/commands/effort/effort.tsx` (11) |

Centrality finds the leaf primitives; churn finds the tool surfaces. The two
columns share nothing.

## 7. Render and determinism

**1024-token budget** (chars/4): 14 files, 1,024 tokens, 4,109 chars, in rank
order — `tokenAnalytics.ts`, `bedrock.ts`, `release-binaries.yml`,
`auth-code-listener.analytics.test.ts`, `Tool.types.test.ts`, `ripgrep.test.ts`,
`providerRecommendation.test.ts`, `tokens.ts`,
`SessionTokensIndicator.test.ts`, `messagesClient.ts`, `loadPluginAgents.ts`,
`oauth/index.ts`, `postinstall-warmup.mjs`, `editorState.test.ts`.

Verbatim head of the rendered map:

```
src/agent/context/tokenAnalytics.ts:
⋮
  export interface TokenUsageEntry
⋮
  export interface TokenAnalytics
⋮
  export class TokenUsageTracker
⋮
src/providers/model/bedrock.ts:
⋮
  export const getBedrockInferenceProfiles = memoize(async function (): Promise<
⋮
  export function findFirstMatch(
⋮
```

**2048-token budget:** 20 files — the same prefix plus `fileStateCache.ts`,
`parseConnectUrl.d.ts`, `runShellCommand.test.ts`, `generate-sdk-types.ts`,
`fsOperations.ts`, `usageContribution.test.ts`, `model.github.test.ts`. A YAML
workflow renders its `name:` / `on:` / `jobs:` keys as "signatures", which is
what including null-mask languages costs.

**Determinism:** the rendered string is byte-identical across two in-process
runs, and the rank order is identical. 905 of 3,711 nodes have an exact float
score tie (635 of them share the minimum — isolated nodes carrying only teleport
mass), but **0 ties fall inside the top 200**. The path tie-break is required for
a total order; it does not change what renders at these budgets.

## 8. The neighbourhood, repriced (2026-08-17)

Probes `11`–`13`, run after [`prior-art.md` §2](prior-art.md#2-the-correction--bounded-depth-is-not-a-closure)
reinstated the bounded-depth lane on the strength of one number — *"p90 ~1k
tokens"*. That number prices the answer as a **list of paths**; the product
described in [README §8](README.md#8-revised-design--three-lanes) is **rendered
definition signatures**. Probe `10` now labels its column accordingly.

Corpus at this run: 3,361–3,364 module files (it grew from 3,349 — the probes
themselves are tracked `.ts`).

### 8.1 A rendered file costs far more than the §7 sample suggested

`renderFileSection` over every module file's top-level defs, same selection rule
`renderMap` uses:

| | chars | tokens (chars/4) |
|---|---|---|
| p50 | 236 | 59 |
| p90 | 922 | 231 |
| p99 | 2,617 | 654 |
| max | 13,756 | 3,439 |
| mean | 418 | 105 |

§7's 14-file render works out to ~73 tokens/file, but those 14 were selected by
*fitting a 1,024-token budget in rank order* — the cheap tail of the
distribution. The mean is **105**, and the distribution is skewed enough that a
neighbourhood's price is not its size times any constant. 254 files (7.6%) have
no top-level def at all; `renderMap` skips them, and `11` prices them at their
header line.

### 8.2 The two units, over the same graph and every file as a seed

| direction | depth | files p50 / p90 | path list p50 / p90 | **signatures p50 / p90** | ratio at p90 |
|---|---|---|---|---|---|
| forward | 1 | 3 / 13 | 26 / 111 | 563 / 4,545 | **40.9×** |
| forward | **2** | 22 / 119 | 187 / 1,012 | **5,728 / 22,639** | **22.4×** |
| forward | 3 | 79 / 404 | 672 / 3,434 | 17,371 / 60,635 | 17.7× |
| reverse | 1 | 1 / 9 | 9 / 77 | 188 / 1,649 | 21.4× |
| reverse | **2** | 6 / 121 | 51 / 1,029 | **791 / 16,716** | 16.2× |
| reverse | 3 | 22 / 559 | 187 / 4,752 | 3,245 / 65,248 | 13.7× |
| undirected | 2 | 353 / 1,044 | 3,001 / 8,874 | 52,041 / 148,206 | 16.7× |

**Forward depth 2 at p90 is 22,639 tokens.** That is the same price as the whole
strongly-connected core (~22–24k, [`two-layer-viability.md` §4.5](two-layer-viability.md#45-both-directions-are-degenerate--the-graph-is-one-giant-core)),
which is what the lane was withdrawn for costing in the first place. In the
signature unit the "middle ground" is not a middle ground.

### 8.3 On the files an agent actually edits, it is worse than p90

Churn leaders, depth 2, both directions:

| churn | file | fwd d2 files | fwd sigs | rev d2 files | rev sigs |
|---|---|---|---|---|---|
| 27 | `src/tools/FileReadTool/FileReadTool.ts` | 151 | **33,931** | 117 | 16,649 |
| 22 | `src/tools/BashTool/BashTool.tsx` | 243 | **50,518** | 135 | 17,447 |
| 19 | `src/tools/AgentTool/AgentTool.tsx` | 367 | **69,339** | 55 | 8,662 |
| 16 | `src/tools/FileReadTool/prompt.ts` | 3 | 662 | 263 | 38,984 |
| 13 | `src/tools/GrepTool/GrepTool.ts` | 84 | 18,725 | 77 | 9,577 |
| 11 | `src/commands/effort/effort.tsx` | 43 | 12,733 | 2 | 532 |

As a path list the same rows are 1,284 / 2,066 / 3,120 / 26 / 714 / 366 tokens.

### 8.4 Commented-out imports: real, and immaterial

`06` and `10` parse specifiers off the raw source deliberately —
`maskSourceForLang` blanks string contents and a specifier *is* a string. What
was missing is a filter on the **statement**: `// import { x } from './y'` became
an edge. The mask answers that too, because it preserves length and offsets, so
the keyword at the match index is blanked inside a comment and survives in code.
`buildImportGraph({skipCommented:true})` applies exactly that test.

| | raw | filtered | delta |
|---|---|---|---|
| matches | 24,148 | 23,901 | −247 (1.02%) |
| resolved | 19,077 | 19,024 | −53 (0.28%) |
| distinct edges | 18,243 | 18,204 | −39 (0.21%) |
| forward d2 p50 / p90 | 22 / 119 | 21 / 118 | −1 / −1 |
| reverse d2 p50 / p90 | 6 / 121 | 6 / 120 | 0 / −1 |

135 files are affected, led by benches carrying example code in comments
(`cold-start-retained-bench.ts` 31, `cli-search-edit-ab.ts` 16). 39 phantom
edges are real — `src/agent/context/context.ts → src/shared/constants/betas.ts`
among them — but at 0.21% of edges the distribution does not move, so **the
published graph stands** and `06`/`10` keep `skipCommented: false` to reproduce
it. The filter stays available in `lib.ts` for anything built later.

### 8.5 The 21% unresolved and the 22% empty reverse are both clean

Neither was a hole. Of 5,060 unresolved specifiers:

| bucket | count | share |
|---|---|---|
| bare package (`react` 817, `path` 446, `fs` 389, …) | 3,607 | 71.3% |
| `node:` / `bun:` builtin | 1,292 | 25.5% |
| relative, no tracked file | 159 | 3.1% |
| `src/`-prefixed, no tracked file | 2 | 0.0% |

**96.8% is legitimately outside the repo.** The 161 repo-shaped misses are test
fixtures and doc examples (`./foo`, `./missing`, `./X.js`, `../lib/format.js`)
plus non-JS assets a module imports as data (`prompt.txt`, `package.json`).

And of the 746 files (22.2%) with an empty reverse depth-2 neighbourhood:

| bucket | count | share |
|---|---|---|
| test file | 620 | 83.1% |
| `scripts/` | 99 | 13.3% |
| `.d.ts` | 20 | 2.7% |
| entrypoint / vendor / stub | 3 | 0.4% |
| **residue** | **4** | **0.5%** |

One residue file is under `src/` (`shared/types/generated/google/protobuf/timestamp.ts`),
and **zero** residue files have a basename appearing in any unresolved specifier.
The import graph is trustworthy; the repricing in §8.2 stands on it unchallenged.

## 9. Gate 1, answered offline (2026-08-17)

Probe `14`. The question the whole study came down to: **given the file a
session started from, does the neighbourhood contain the files that session went
on to touch?** No agent run is needed to answer it — 315 local transcripts
already record it.

Per session, seed = the first module file touched; ground truth = every other
module file touched afterwards. 96 of 315 transcripts yield such a pair (p50 5
ground-truth files, mean 8.9). Answer size is priced as a path list, the only
form §8 leaves affordable.

| arm | files p50 / mean | recall p50 / mean | hit ≥1 | recall per 1k tok |
|---|---|---|---|---|
| fwd d1 | 7 / 13 | 0.0% / 11.5% | 38.5% | 2.00 |
| **fwd d2** | 29 / 68 | **0.0% / 15.6%** | 41.7% | 1.08 |
| rev d1 | 4 / 7 | 12.5% / 20.4% | 60.4% | **6.19** |
| rev d2 | 33 / 48 | 21.4% / 28.9% | 67.7% | 2.27 |
| undir d1 | 12 / 20 | 25.0% / 30.6% | 71.9% | 3.17 |
| undir d2 | 163 / 507 | 75.0% / 67.4% | 89.6% | 0.45 |
| **same-dir** | **12 / 16** | **33.3% / 40.6%** | 74.0% | **4.68** |
| same-dir + rev d1 | 20 / 21 | 50.0% / 44.0% | 77.1% | 3.35 |
| same-dir + undir d1 | 24 / 32 | 50.0% / 46.7% | 80.2% | 2.63 |
| same-dir + undir d2 | 174 / 511 | 81.0% / 69.9% | 91.7% | 0.57 |
| churn-50 | 50 / 50 | 11.5% / 21.9% | 62.5% | 0.52 |
| churn-200 | 199 / 199 | 50.0% / 53.1% | 88.5% | 0.31 |
| random, sized to fwd d2 | 29 / 68 | 0.0% / 2.7% | 10.4% | 0.03 |

**Three readings, in order of how much they settle.**

1. **Forward depth 2 — the configuration the lane was reinstated for — has a
   median recall of zero.** It finds nothing in 58.3% of sessions, and it is
   beaten on every axis by `ls` of the seed's own directory: fewer files (12 vs
   29), triple the median recall, 4.3× the recall per token. The graph arms do
   clear the chance floor (2.7% mean), so the signal is real; it is just worse
   than free.
2. **What carries signal is depth *one*, plus directory locality.** Adding the
   reverse direct edges to `same-dir` lifts median recall 33.3% → 50.0% for 8
   more files. That is a genuine marginal gain — and `rev d1` is precisely what
   one `Grep` for importers returns. No index is required to get it.
3. **Recall is only buyable by size.** `undir d2` reaches 75% and
   `same-dir + undir d2` 81%, at 163–174 files median and ~507 mean — an order of
   magnitude worse per token than the baseline, and the mean shows the tail
   collapsing into the core again.

Precision says the same thing from the other side: the share of the answer that
was actually touched is **0.0% median / 8.1% mean for fwd d2**, against 13.0% /
20.6% for `same-dir`.

**Verdict: Gate 1 fails.** No arm built on the import graph beats the free
baseline at comparable size, and the two signals that do work — sibling files
and direct importers — are already answerable with `Glob` and `Grep`. Lane A is
withdrawn for good; see [README §8](README.md#8-revised-design--three-lanes).

**Limitation, stated because it bounds the conclusion:** one user, one
repository, and the ground truth is restricted to files the graph could name at
all. Both favour the graph, and it lost anyway.

## 10. What was not measured

- The mask-alone vs `scanSymbols`-alone split (§3).
- Any effect on a **live** session. §9 is retrospective: it scores what an agent
  did against what an arm would have returned, which is not the same as showing
  that being handed the arm changes behaviour. It is enough to reject, not enough
  to accept — and nothing here is being accepted.
- Whether the same result holds on a multi-package monorepo, where directory
  locality and import topology are less aligned than in a single-entrypoint
  bundle.
