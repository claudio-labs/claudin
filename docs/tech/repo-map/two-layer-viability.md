# Two-layer repo index — viability study

> **Status:** measured on 2026-08-17. **Camada 1 is viable only at ~1/70 of the
> information density proposed, and the artifact it would replace already exists
> at 97.3% accuracy. Camada 2 is not viable — all three of its operations are
> measured dead, each for a different reason.** What survives is a third thing
> neither layer describes, costs zero prompt tokens, and is a small addition to
> a linter that already ships.
>
> Companion to [`README.md`](README.md) (the v1 evaluation) and
> [`measurements.md`](measurements.md). Probe:
> [`scripts/bench/repomap/`](../../../scripts/bench/repomap/).

## 1. The proposal

```
Camada 1 (estática, cacheada no prefixo)
  └─ árvore de diretórios + exports públicos por módulo
     ~800 tokens, muda raramente, tree-sitter tags simples

Camada 2 (tool sob demanda, fora do prefixo)
  └─ SQLite: nodes(symbol, file, kind) + edges(from, to, kind)
     tools: who_calls(sym), impact_of(file), defines(sym)
```

The split is the right instinct, and it fixes the specific thing that killed v1:
Camada 1 needs **no ranking function**, so it sidesteps the PageRank-vs-churn
failure ([README §5.6](README.md#56-centrality-is-not-what-people-edit),
ρ = −0.104) entirely. A tree does not have to decide what matters. That is a real
improvement over v1 and it is why this study exists instead of a one-line no.

Both layers were then sized against the tree. Neither survives as written.

## 2. Method

Two new measurements, both committed so they can be re-run:

- **Camada 1 sizing** — render every candidate form of "directory tree + public
  exports" at depths 1–5 over the 3,175 tracked `.ts`/`.tsx` files in `src/`, and
  count characters and tokens at 4 chars/token. Plus a claim-by-claim accuracy
  audit of the artifact this would replace.
- **Camada 2 sizing** —
  [`08-impact-of-answer-size.ts`](../../../scripts/bench/repomap/08-impact-of-answer-size.ts):
  build the real import graph, compute the direct and transitive reverse-import
  sets for all 3,359 nodes, and size the answer each operation would return.

## 3. Camada 1 — the budget is the whole story

### 3.1 What actually fits in 800 tokens

| render | lines | chars | tokens | vs 800-token budget |
|---|---|---|---|---|
| depth 1 (`src/`) | 1 | 12 | 3 | fits |
| depth 2 (18 slices + counts) | 19 | 332 | **83** | fits |
| depth 3 | 319 | 8,430 | **2,108** | 2.6× over |
| depth 4 | 408 | 11,733 | 2,934 | 3.7× over |
| depth 5 | 418 | 12,166 | 3,042 | 3.8× over |
| depth 2 **+ public export names** | 18 | 203,690 | **50,923** | 64× over |
| depth 3 **+ public export names** | 315 | 215,399 | 53,850 | 67× over |
| every export name, comma-joined | — | 222,991 | **55,748** | 70× over |

There are **10,841 non-test top-level exports** in `src/`. "Exports públicos por
módulo" is not an 800-token artifact; it is a 56,000-token artifact, off by
**~70×**. No pruning rule closes a gap that size — dropping 90% of the exports
still leaves 5,600 tokens, and a 90%-pruned export list is not a map, it is a
ranking, which puts Camada 1 straight back into the v1 failure it was designed to
avoid.

What *does* fit is depth 2: 18 lines of `src/agent/ (491)`. That is 83 tokens and
it is essentially what `AGENTS.md` already narrates in prose. Depth 3 — the first
level with real navigational content — is 2,108 tokens, so the honest budget for
a useful Camada 1 is **~2.1k tokens, not 800**.

### 3.2 The artifact it would replace already exists

`.claudin/rules/search-strategy.md` is 467 lines / 28,745 chars (~7.2k tokens),
auto-loaded on any `src/**` file via its `paths:` frontmatter. Its **Module Map**
(lines 199–313, 10,384 chars) is a depth-3 ASCII tree with file counts and
per-directory annotations — exactly Camada 1, hand-written, already shipping, and
already in the prefix.

So Camada 1 is not a new capability. It is a proposal to *generate* an artifact
that exists. That makes its value entirely a question of whether the generated
version would be **more accurate** than the hand-written one. So that was
measured.

### 3.3 The hand-written map is 97.3% accurate

183 mechanically checkable claims audited against the tree at HEAD:
**178 correct, 5 wrong.**

- 37 nested `.ts(x)` counts: **36 exact**. The counting convention that makes
  them true is tracked files, recursive, tests included.
- 18 top-level counts, self-labelled "approximate, measured 2026-08-15": 10
  exact, 8 drifting by 2–7 files (≤1.4% relative, except `__tests__` 6→8).
- 15 of 15 numeric thresholds match source (`GREP_PIVOT_MIN_FILES=5`,
  `GREP_PIVOT_THRESHOLD_CHARS=6_000`, `GLOB_MAX_PATHS=50`,
  `DIFF_FILE_LINE_BUDGET=60`, and 11 more).
- ~95 named paths resolve; all 23 named tool directories exist; both negative
  claims (`src/grpc/`, `src/proto/claudin.proto` absent) hold.
- 15 of 17 symbol attributions correct.

A generator does not beat 97.3%. It changes *which* 2.7% is wrong.

### 3.4 …and its 5 errors are all mechanically checkable

Verified independently, not taken from the audit:

| # | Map says | Reality |
|---|---|---|
| 1 | `src/platform/privacy/` | does not exist; privacy is `src/platform/config/privacyLevel.ts` |
| 2 | `model/ … model.ts (getPrimaryModel, …)` | `getPrimaryModel` is `src/providers/presets/providerModels.ts:25` |
| 3 | same row, `getContextWindowForModel` | is `src/agent/context/context.ts:82` — a different **slice**, and the map's own `agent/context/` row already describes that file |
| 4 | `openaiShim.ts (… ~2.2k lines)` | the file is **51 lines** (a barrel); the implementation is `src/providers/shims/openaiShim/`, 4,896 lines across 19 files |
| 5 | `transport/ (35)` | **37** |

Every one is a fact a script can check: does this path exist, does this symbol
live where the map says, is this count right, is this line count right. **That is
the actual finding of this study** — the map's error surface is not "it is stale
prose", it is five mechanical facts, and the fix for mechanical facts is a
checker, not a generator (§5).

Errors 2 and 3 are the costly ones: an agent following the map greps the wrong
file for the two functions most relevant to context-window bugs. Error 4 actively
misleads anyone sizing a read.

### 3.5 The existing linter is blind to exactly where they live

`src/memory/instructions/rulesLint.ts` already verifies prose path citations —
`extractProsePathCitations` → `isCheckableProsePath` → `citationExists`, run in CI
by `scripts/verify/rules-check.ts` (`bun run verify:rules`). It is why ~95 named
paths resolve and why only one path error survived.

But `INLINE_CODE_RE = /`([^`\n]+)`/g` (`rulesLint.ts:40`) scans **inline code
spans only**, and the Module Map is a **fenced** block — the ``` opens at
`search-strategy.md:208`. Inside a fenced block the lines carry no backticks, so
**none of the tree's 9,600 characters is checked at all.** 33% of the file, and
all 5 errors, sit in the one region the linter cannot see.

That is a gap in a shipping checker, not a missing subsystem.

### 3.6 tree-sitter is not needed

The proposal says "tree-sitter tags simples". `scanSymbols`
(`src/tools/shared/codeOutline/scanSymbols.ts:94`) already extracts definitions
for 32 languages with **zero dependencies**, and
[README §2](README.md#2-what-claudin-already-provides) records that its masking
helper is already public. Adding tree-sitter would mean a new dependency and
binary weight to do something the tree already does — and per team memory
(`symbol-parser-options-researched.md`) the open tree-sitter blocker here is the
synchronous `scanSymbols` call in `toolResultSummarizer`, which a repo map does
not touch. Drop it.

### Verdict — Camada 1

Viable, but not as a new artifact and not at 800 tokens. Its real form is: **fix
the 5 errors, and teach the existing linter to see inside the fenced tree** (§5).

## 4. Camada 2 — three operations, three different failures

### 4.1 `impact_of(file)` is a constant function

The reverse-import closure over 3,359 nodes:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| **direct** importers | 1 | 9 | 68 | 493 |
| **transitive** importers | **2,462** | **2,462** | 2,467 | 2,496 |
| answer size, paths only | ~24,403 tok | ~24,403 tok | ~24,453 tok | ~24,762 tok |

p50, p90 and p99 are the *same number*. In a single-entrypoint bundled CLI,
almost everything transitively imports almost everything, so the reverse closure
of nearly any file is the same ~2,462-file set — 73% of the graph. **70.3% of
files (2,361 of 3,359) return an answer above 2,000 tokens.**

The churn table is where this stops being an abstraction:

| file | churn | direct | transitive | answer |
|---|---|---|---|---|
| `src/tools/FileReadTool/FileReadTool.ts` | 27 | 18 | 2,462 | ~24,403 tok |
| `src/tools/BashTool/BashTool.tsx` | 22 | 28 | 2,462 | ~24,403 tok |
| `src/tools/AgentTool/AgentTool.tsx` | 19 | 8 | 2,462 | ~24,403 tok |
| `src/tools/GrepTool/GrepTool.ts` | 13 | 9 | 2,462 | ~24,403 tok |
| `src/commands/effort/effort.tsx` | 11 | 1 | 2,462 | ~24,403 tok |

Every file an agent actually edits gets the **identical** answer. An operation
whose output does not vary with its input carries no information, and this one
costs 24k tokens to say so.

This also corrects the record on the prior attempt. Team memory
(`code-review-graph-evaluated-rejected.md`) measured a SQLite symbol graph on
this repo on 2026-08-08 and got a 203k-token impact answer, attributing it to the
284 MB database and a parser that missed 445 of 495 `export const`. Those were
real defects, but they were not the cause: **the question is degenerate on this
topology.** A perfect parser and a 200 KB in-memory graph return the same
constant. That closes the door rather than leaving it ajar for a better
implementation.

### 4.2 The informative version is one Grep

Direct importers *do* vary (p50 1, p90 9, max 493 — `envUtils.ts` 264,
`lazySchema.ts` 103). But "who imports this module" against a `src/…` alias
tree is a single exact-string search, which `Grep` answers today with no index,
no database and no staleness. A tool wrapping it would have to beat one call, and
the graph costs ~1 s to build before answering.

### 4.3 `who_calls` and `defines` already shipped — at zero usage

`src/tools/LSPTool/prompt.ts:5` lists the operations already available:
`goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol,
goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls`.

`defines(sym)` is `goToDefinition`/`workspaceSymbol`. `who_calls(sym)` is
`findReferences`/`incomingCalls`. Both are semantically exact — a language server
resolves overloads, re-exports and shadowing that a `nodes/edges` table cannot —
and both are **never stale**, because the server reads the live buffer.

They also have measured demand. Team memory
(`lsp-tool-reintroduced-plugin-only.md`): LSPTool was **removed for 0 usage**,
then reintroduced 2026-06-17 as plugin-only, read-only. Camada 2 proposes
rebuilding, on a staleness-prone index, the surface that already exists and was
not used. `Grep`'s `output_mode:"symbols"` covers a third path.

### 4.4 The cost nobody priced

SQLite adds what neither of the above has: a schema, a build step, a cache
location, an invalidation rule, and a staleness window that is wrong exactly when
the agent is mid-edit — the moment the answer matters. The 2026-08-08 audit's own
benchmark had the graph **losing to reading the diff**.

### 4.5 Both directions are degenerate — the graph is one giant core

§4.1 measured the reverse closure and left the forward direction open, because
"what does X depend on" was the last query with a plausible shape. It was then
measured
([`09-forward-closure-size.ts`](../../../scripts/bench/repomap/09-forward-closure-size.ts)):

| forward closure | p10 | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| direct dependencies | 0 | **3** | **13** | 38 | 224 |
| transitive dependencies | 0 | **2,361** | **2,361** | 2,369 | 2,532 |
| answer size, paths only | — | ~22,411 tok | ~22,411 tok | — | ~24,050 tok |

**67.8% of files (2,278 of 3,360) have a transitive closure of *exactly* 2,361**,
and there are only **50 distinct closure sizes across 3,360 files**. 73.3% of
files produce an answer over 2,000 tokens. Every churn-top file again returns the
same number — `FileReadTool.ts`, `BashTool.tsx`, `GrepTool.ts`, `effort.tsx` all
at 2,361 / ~22,411 tokens.

So the import graph has **one giant strongly-connected core** that nearly every
file both reaches and is reached by. Transitive reachability is therefore close to
a constant relation in *either* direction, and no personalization, ranking or
budget changes that: the set is the same before you rank it.

What is left is the **direct** edges, and only those: forward p50 3 / p90 13,
reverse p50 1 / p90 9. Those are small, informative, and already answered by a
single `Grep` — either the import block of the file itself, or one exact-string
search for its specifier.

> **Corrected 2026-08-17.** The paragraph above overstates the result. It is true
> of *closures*, and false of **bounded-depth** traversal, which is what the two
> sibling implementations actually compute and which this study had not measured.
> Directed depth 2 is a genuine middle ground — 272–286 distinct answer sizes, p50
> 6–22 files, p90 answer ~1k tokens — so "there is nothing in between" was wrong.
> The collapse into the core happens at **undirected** depth 3 (p50 2,089). Full
> table and the effect on Lane A: [`prior-art.md` §2](prior-art.md#2-the-correction--bounded-depth-is-not-a-closure).

### Verdict — Camada 2

Not viable, and the failure is deeper than the three operations. `impact_of` is
degenerate; `who_calls`/`defines` already ship with better semantics and no
staleness; and §4.5 shows that **no transitive query over this graph carries
information in either direction**. The informative residue in both directions is
the direct edges, which is one `Grep`. No implementation quality changes any of
this — it is a property of a single-entrypoint bundled monolith, not of a parser
or a database.

**Scope of that verdict, after the correction above:** it holds for `impact_of` as
specified (a closure), for the SQLite symbol table, and for the ranked global map.
It does **not** cover a bounded-depth directed query, which
[`prior-art.md`](prior-art.md) reinstates as an open question decided by Gate 1.

## 5. What survives: verify the map, don't generate it

> **BUILT 2026-08-17, and the title of this section is now half wrong.** All
> four checks below ship, plus a generator the section argued against — under a
> constraint that was not on the table when it was written. See
> [§5.1](#51-what-shipped-and-what-the-plan-got-wrong).

The measurements point somewhere neither layer does.

| | prompt tokens | build | staleness | fixes the 5 errors |
|---|---|---|---|---|
| Camada 1 as proposed | 800 (real: 2.1k–56k) | new subsystem | rebuild per session | yes |
| Camada 2 as proposed | 0 (+24k per call) | SQLite index | window | n/a |
| **Map verifier** | **0** | ~150 lines in an existing linter | none (runs in CI) | **yes** |

Extend `lintRuleFiles` to check the claims inside fenced blocks in rule files —
the region it currently cannot see:

1. **Path claims** — reuse `citationExists`/`hasProjectAnchor` (`rulesLint.ts:173,188`)
   on tree lines. Catches error 1.
2. **Count claims** — parse `dir/ (N)` and compare against tracked `.ts(x)`,
   recursive, tests included, with a stated tolerance. Catches error 5.
3. **Symbol attributions** — parse `file.ts (symA, symB)` and confirm each symbol
   is exported by that file, reusing `scanSymbols`. Catches errors 2 and 3.
4. **Line-count claims** — parse `~N lines` / `~Nk lines` and compare. Catches
   error 4.

This costs zero context, runs where it already runs (`bun run verify:rules`, in
`.github/workflows/pr-checks.yml`), keeps the 178 judgment claims a generator
cannot write, and turns the one thing a generator would have been good at — being
mechanically right — into a gate. The map stays hand-written and human-readable;
it just stops being able to lie about paths, counts and symbols.

Cheap follow-on, not required: the audit found `src/platform/` has ~20
subdirectories the map never names (it covers 12 of ~32) — a coverage gap, not an
error, and a decision for whoever owns that rule.

### 5.1 What shipped, and what the plan got wrong

`src/memory/instructions/rulesClaims.ts` extracts the claims, `rulesLint.ts`
reports them, `rulesMapSync.ts` rewrites them, `ruleMapAutoSync.ts` runs at
session start. Findings are **warnings**, matching the existing `missing_path`
severity, so CI still fails on errors only. Run against this tree it reported
errors 1, 2, 3 and 4 with **no false positives**, and all four are fixed.

**The generation verdict was narrower than this section assumed.** What was
measured and rejected is a generator that writes *judgment*: an aider-style
ranked map, and a `search-strategy.md` synthesised from session history. Both
lose to a hand-written artifact that is already 97.3% accurate, and the
standing warning is that "a rule that misdirects is worse than no rule". None
of that constrains a generator whose output contains **only claims this
verifier re-derives** — a tree, `(N)` counts, and `TODO` where a purpose would
go. It cannot misdirect because it asserts nothing a checker cannot falsify.
That is what now runs in every project, and the split is enforced rather than
encouraged: a hand-written map is healed (numbers only, never restructured), a
generated one is regenerated whole with its annotations carried across by path.

Four things the plan above got wrong, all found by running it:

- **Item 1 alone is not the product.** Path existence inside fenced blocks — the
  cheap check, the one described as reusing `citationExists`/`hasProjectAnchor`
  — catches **1 of the 3** misleading defects, and it is the item that needs the
  tree parser. Items 3 and 4 catch the other two and need no tree at all: both
  resolve their file by unique basename, ambiguous → skipped.
- **A size claim must sit in the parenthetical its filename opens.** Associating
  a count with the nearest filename to its left read *"eight lines of a
  2,200-line file"* — a sentence about whatever file the agent had open — as a
  claim about the `FileReadTool.ts` cited beside it. Requiring attachment costs
  one correctly-written prose claim and removes the false one.
- **The tree parser needs two guards, and both are load-bearing**: only lines
  carrying a `├──`/`└──` marker are entries, and the `←` annotation is split off
  before tokenizing. Dropping the second turns every annotated line into a
  phantom — `← model.ts (…)` under `providers/` becomes `src/providers/model.ts`
  — which produced 14 false findings in one run.
- **A symbol list needs a code-shaped filter.** Requiring every member to carry
  an interior capital or `_` is what separates `providers.ts (getAPIProvider)`
  from the gloss `activeProvider.ts (resolver)`.

Item 2's tolerance was the open decision and is settled as **relative, ±10% with
a floor of 3** (`dirCountDrifted`), for both reporting and healing. Reason: 9 of
55 counts had drifted within two days of being measured, none by more than 1.2%,
so an exact ratchet over numbers nobody re-measures is a permanently red check —
and a permanently red check gets deleted. Error 5 is therefore not reported
today, by design; the threshold exists to catch a slice that died, moved or
doubled.

Still unmeasured, and worth saying plainly: **no data exists on whether a
generated map helps in a fresh project.** Every measurement in this study ran
against this repo, which had a 467-line hand-written map. The argument for
shipping it everywhere is that its claims are verified rather than that its
value is proven.

## 6. What this changes in the main doc

- **Lane A is withdrawn.** [README §8](README.md#8-revised-design--three-lanes)
  kept a focused dependency-neighbourhood tool as the one lane worth building
  behind a flag. §4.5 removes its query: both closure directions are constants, so
  a "focused neighbourhood" is either the whole core (~22k tokens, no signal) or
  the direct edges (one `Grep`). Nothing in between exists on this graph. The
  flag, the tool and Phases 1–5 are not worth writing.
  **Superseded — see [`prior-art.md` §2](prior-art.md#2-the-correction--bounded-depth-is-not-a-closure).**
  Lane A is partially reinstated in a simpler form: bounded directed depth ≤2, no
  ranking at all. What stays withdrawn is the PageRank and the personalization
  vector, not the idea of a focused neighbourhood.
- Lane B (head injection) is unaffected — still rejected, now with a token budget
  measured against it as well as a ranking failure.
- Camada 2 is recorded as rejected on measurement, so the SQLite symbol graph
  does not come back a third time without new topology.
- The net result across these studies: **no ranked, global or closure-based repo
  index is worth building on this repository.** What survives is the map verifier
  in §5 (not a graph, not an index) and one open question — bounded directed depth
  ≤2, unresolved until Gate 1 runs.
  **Gate 1 ran on 2026-08-17 and the question is closed**
  ([`measurements.md` §9](measurements.md#9-gate-1-answered-offline-2026-08-17)):
  forward depth 2 recalls a median of 0.0% of what a session goes on to touch,
  losing to one `ls` of the seed's directory. Drop the qualifier — **no repo
  index of any shape is worth building here.** The map verifier in §5 is the only
  thing left standing.

## 7. Not measured

- Whether the ~2.1k-token depth-3 tree would change agent behaviour at all if it
  *were* generated. No A/B was run, because the accuracy argument (§3.3) removed
  the reason to run one.
- Whether the count tolerance in §5 should be absolute, relative, or auto-updated
  by `/refresh-rules`. That is a design decision, not a measurement.
- Whether the degeneracy in §4.5 is specific to this repo's single-entrypoint
  bundle. It very likely does not hold for a multi-package monorepo, so this
  conclusion should not be exported to other codebases without re-running the
  probe there.
