# Repo map — measurements

Everything the [evaluation](README.md) cites. Run on 2026-08-16 against this
repository at `9551b0b9` (branch `repo_index_map`), warm filesystem, median of 3
after a discarded warm-up pass, on Linux 6.18 / Bun 1.3.11.

The probe is committed at [`scripts/bench/repomap/`](../../../scripts/bench/repomap/)
— re-run it rather than trusting these numbers. It is a 1,267-line faithful
implementation of proposal v1 plus two controls, deliberately kept out of `src/`.

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

## 8. What was not measured

- The mask-alone vs `scanSymbols`-alone split (§3).
- What the 21% of unresolved import specifiers consists of (§5, V5).
- Whether a focused/personalized query over V5 beats `Grep` + outline reads in
  real tasks — this is Gate 1 in [README §11](README.md#11-acceptance-gates) and
  the reason the tool surface is Phase 5, not Phase 1.
- Any effect on real sessions. Every number here is offline; none of it is
  evidence that a shipped index changes agent behaviour.
