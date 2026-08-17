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

From the repo root. Only one ordering constraint: `07` consumes the
`importRanks.json` that `06` writes. Everything else is independent.

```bash
bun scripts/bench/repomap/01-corpus-and-masks.ts       # corpus shape, which langs have a mask
bun scripts/bench/repomap/02-extraction-cost.ts        # read / mask+scanSymbols / regex split, median of 3
bun scripts/bench/repomap/03-graph-rank-render.ts      # defIndex, IDF graph, PageRank, render, determinism
bun scripts/bench/repomap/04-diagnose-top-file.ts      # why the #1 file is #1 (weight attribution)
bun scripts/bench/repomap/05-ranking-variants.ts       # V1-V4: keyword denylist, top-level defs, lang filter
bun scripts/bench/repomap/06-import-graph-control.ts   # V5: PageRank over real import specifiers
bun scripts/bench/repomap/07-churn-correlation.ts      # centrality vs git churn (Spearman)
bun scripts/bench/repomap/08-impact-of-answer-size.ts  # reverse (importer) closure size — `impact_of`
bun scripts/bench/repomap/09-forward-closure-size.ts   # forward (dependency) closure size
bun scripts/bench/repomap/10-bounded-depth-neighbourhood.ts  # depth 1/2/3 balls, the sibling defaults
bun scripts/bench/repomap/11-neighbourhood-render-cost.ts    # the same balls priced as paths vs signatures
bun scripts/bench/repomap/12-commented-import-edges.ts       # edges from imports inside comments
bun scripts/bench/repomap/13-unresolved-specifiers.ts        # the 21% that never resolves, and empty reverse balls
bun scripts/bench/repomap/14-oracle-recall.ts                # THE GATE: neighbourhood vs real sessions, against 4 baselines
```

`02`, `03` and `11` do a full extraction pass over ~3,700 files and take roughly
3 s each per repetition; the rest are 0.2–6 s. `06` writes `importRanks.json`
beside these scripts (gitignored).

`08`–`14` were added after the first evaluation and are what the later findings
rest on: `08`/`09` killed the closure-based query, `10` reinstated the
bounded-depth one, and `11` narrowed it to a path list by pricing the answer in
the unit the product would actually emit. `14` closed the study: scored against
96 real sessions, the neighbourhood loses to `ls` of the seed's own directory.
Stopping at `07` reproduces only the first half of the study.

`14` reads session transcripts from `~/.claudin/projects/<slug>/`, so it measures
whoever runs it. On a fresh machine it will report zero usable sessions rather
than fail.

Absolute numbers move slightly with every commit — the corpus grows. What should
not move is the *shape* of the findings: the identifier graph stays dense, the
top of the ranking stays dominated by files that contain many `import`/`export`
tokens, centrality stays uncorrelated with churn, both closures stay constant,
the signature price of a depth-2 ball stays an order of magnitude above its
path-list price, and the neighbourhood keeps losing to `same-dir` in `14`. If any
of those flip, the evaluation is out of date and the doc needs revisiting.

## Layout

| File | Contents |
|---|---|
| `lib.ts` | The prototype: enumeration, `extractIdents`, `extractPass`, `buildGraph` (IDF + fanout cap + common-name penalty), `rankFiles` (CSR power iteration, dangling mass via the teleport vector, personalization), `renderMap`, plus the import-graph builder (`buildImportGraph`, `resolveSpec`, `ball`) shared by `06`, `08`–`14` |
| `keywords.ts` | Per-language keyword denylists — the v1 proposal's Phase 0, which `05` toggles |
| `01`–`14` | One driver per question, each printing a table |

`buildImportGraph` takes `skipCommented`, which drops a match whose
`import`/`export`/`require` keyword is blanked in `maskSourceForLang`'s copy —
i.e. the statement sits in a comment. The specifier itself is always read from
the raw source, because masking blanks string contents and a specifier is a
string. Every driver runs with the filter **off**, because `12` measured it at
0.21% of edges and the published numbers were taken without it.

`lib.ts` imports `detectOutlineLangFromPath`, `maskSourceForLang` and
`scanSymbols` from `src/tools/shared/codeOutline/` — that reuse is the one part
of the proposal that measured well, and it is why the prototype needs no
dependency.

## Attribution

The algorithm is [Aider](https://github.com/Aider-AI/aider)'s (Paul Gauthier,
MIT): reference graph over files, IDF-weighted edges, PageRank, token-budgeted
render. `Gitlawb/openclaude`'s `src/context/repoMap/` is a tree-sitter port of the
same design; no queries were ported here.
