---
name: cap-keeps-model-bounded-reads
description: Since PR #252 (2026-09-25) the Bash floor cap leaves whole a read whose command declares its own line bound (sed -n A,Bp, head -N, grep … | head -N) when bound and output are ≤150 lines — ON by default, CLAUDIN_CAP_KEEP_BOUNDED=0; validated by corpus replay + tests, no paid bench
type: project
scope: src/tools/shared/outputFilter/Bash/lineBound.ts, floor.ts, index.ts
impact: functional
paths:
  - "src/tools/shared/outputFilter/Bash/lineBound.ts"
  - "src/tools/shared/outputFilter/Bash/index.ts"
---

**Decision:** `applyBashFilterToStdout` returns a result whole, byte for byte,
in `<bash-output-read>` when the cap would cut it but `commandLineBound`
(`lineBound.ts`) finds the command bounded its own output: `sed -n` numeric
ranges, `head`/`tail -N` over countable files, `awk` NR ranges, those fed by
`cat`/`nl`/`git show rev:path`/`grep`/`rg`, line filters after the bound,
literal `for` loops, glue (`echo`, `cd`, `X=…`, `true`, `wc`, `grep -c`). Both
the declared bound and the printed output must be ≤150 lines, and ≤28k chars.
On by default (user's call: "testes regressivos" as the validation), PR #252.

**Why:** the only cut with a measured request cost
([[cut-results-request-cost-2026-09-25]]): sub-agents re-read after 48% of
capped range reads and 41% of capped searches into a bound, baseline 15%.

**What changes for a teammate:**
- The `<bash-output-read>` wrapper no longer means "the parked passthrough
  flag is on"; bounded reads wear it by default. The summarizer stands aside.
- A new bounded shape goes in `lineBound.ts` with a corpus-verbatim test case
  and a probe in `probes/capKeepBounded.json`; widening the feed allowlist to
  "any producer" is what the data rejected.
- Re-measure with `NODE_ENV=test bun --preload ./src/stubs/test-preload.ts
  scripts/bench/tokens/cut-refetch-census.ts --bound` (plain `bun` fails on
  the sandbox import).

**Rejected:**
- A `FilterSpec` in `filters/`: the registry bypasses pipes and disagreeing
  chains, which is how these reads are written.
- Any `cmd | head -N`: recovery 14%, the baseline, and the token risk lives
  there (test output, logs).
- Touching the Grep summarizer: no excess even with explicit `head_limit`.
- The pre-registered "≥80% of the regex class" gate: FAILED (30% → 42% after
  grammar fixes) because most of that class chains an unbounded `grep -r`,
  `ls` or `cat`; reported, not gated. Kept: the results behind 53% of the
  recoveries; 0 dumps/listings/other pipes kept (the leak gate).

**Evidence:** `lineBound.test.ts` (105), `floor.test.ts` bounded suite,
`read-credit-e2e.ts` scenarios 11-12 (52/52 on the bundle), 43/43 probes red.
Real-use effect not yet measured: re-run the census a week after the merge;
bounded-read recoveries in sub-agents should fall from ~30% toward 15%.
