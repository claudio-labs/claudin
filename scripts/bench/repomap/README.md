# Repo-map probe

The prototype behind [`docs/tech/repo-map/`](../../../docs/tech/repo-map/). It is
a **measurement harness, not a feature** — a faithful implementation of the
proposed repo-map algorithm (identifier-tokenization reference graph, IDF
weighting, PageRank, token-budgeted render) plus two controls, kept in
`scripts/` because the evaluation it produced concluded the algorithm should not
ship as designed.

It exists so the numbers in that doc can be re-derived instead of trusted.
Nothing in `src/` imports any of this.

## Run

From the repo root, in this order (07 consumes what 06 writes):

```bash
bun scripts/bench/repomap/01-corpus-and-masks.ts       # corpus shape, which langs have a mask
bun scripts/bench/repomap/02-extraction-cost.ts        # read / mask+scanSymbols / regex split, median of 3
bun scripts/bench/repomap/03-graph-rank-render.ts      # defIndex, IDF graph, PageRank, render, determinism
bun scripts/bench/repomap/04-diagnose-top-file.ts      # why the #1 file is #1 (weight attribution)
bun scripts/bench/repomap/05-ranking-variants.ts       # V1-V4: keyword denylist, top-level defs, lang filter
bun scripts/bench/repomap/06-import-graph-control.ts   # V5: PageRank over real import specifiers
bun scripts/bench/repomap/07-churn-correlation.ts      # centrality vs git churn (Spearman)
```

02 and 03 do a full pass over ~3,700 files and take roughly 3 s each per
repetition; 06 and 07 are fast. `06` writes `importRanks.json` beside these
scripts (gitignored).

Absolute numbers move slightly with every commit — the corpus grows. What should
not move is the *shape* of the findings: the identifier graph stays dense, the
top of the ranking stays dominated by files that contain many `import`/`export`
tokens, and centrality stays uncorrelated with churn. If any of those flip, the
evaluation is out of date and the doc needs revisiting.

## Layout

| File | Contents |
|---|---|
| `lib.ts` | The prototype: enumeration, `extractIdents`, `extractPass`, `buildGraph` (IDF + fanout cap + common-name penalty), `rankFiles` (CSR power iteration, dangling mass via the teleport vector, personalization), `renderMap` |
| `keywords.ts` | Per-language keyword denylists — the v1 proposal's Phase 0, which `05` toggles |
| `01`–`07` | One driver per question, each printing a table |

`lib.ts` imports `detectOutlineLangFromPath`, `maskSourceForLang` and
`scanSymbols` from `src/tools/shared/codeOutline/` — that reuse is the one part
of the proposal that measured well, and it is why the prototype needs no
dependency.

## Attribution

The algorithm is [Aider](https://github.com/Aider-AI/aider)'s (Paul Gauthier,
MIT): reference graph over files, IDF-weighted edges, PageRank, token-budgeted
render. `Gitlawb/openclaude`'s `src/context/repoMap/` is a tree-sitter port of the
same design; no queries were ported here.
