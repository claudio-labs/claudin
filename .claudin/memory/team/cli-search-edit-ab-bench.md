---
name: cli-search-edit-ab-bench
description: Graded cross-CLI A/B (claudindev vs claude) on one search-edit-build task — what it measures, why the build is the oracle, and the first N=3 result on 2026-08-12
type: project
---

`scripts/profile/cli-search-edit-ab.ts`, built 2026-08-12. Compares the two
CLIs on the everyday shape of agent work — find every call site of one function
across a 10-file JS project, rewrite all five, get the build green — and
**grades every run before believing its tokens**. It is the first bench here
that does: the cheapest way to finish an edit task is to do less of it, and no
token column can tell that apart from efficiency.

**The oracle is the bundler, not the harness.** The five call sites reach the
function through ESM *named* imports, so a missed one fails `bun build` with
"No matching export". One site is reached through an ALIASED import
(`formatCurrency as money`), so a grep for `formatCurrency(` misses it. Three
decoys — a lookalike identifier (`formatCurrencyLabel`), a comment, and a
string event name — catch a blind `s///g`. `--dry-run` proves all of that
(pristine green → one site missed goes red → blind replace stays green but
trips the decoys) for zero model tokens; run it before every campaign.

**First result, N=3, Sonnet 5 pinned both sides, 6/6 runs PASS:**

| | claudin | claude |
|---|---|---|
| cost (CLI-reported) | $0.2466 | $0.4591 (+86%) |
| cost range | $0.2329–$0.2493 | $0.4277–$0.6614 — **separated** |
| first-turn context | 30.3k | 70.5k (+133%) |
| peak context | 37.2k | 76.3k (+105%) |
| cache_read | 178.5k | 939.6k (+427%) |
| output | 3.6k | 3.5k (−2%) |
| wall | 38.3s | 44.3s |

The cost gap is not output and not cache writes — it is **cache_read**, and
cache_read is driven by turn count: claudin emitted 6–7 assistant messages per
run against claude's 12–21, because it batches several tool calls into one
message. Every extra turn re-reads the whole context. The ~2.3x prefix (30.3k
vs 70.5k first-turn context) multiplies that.

**Caveats to keep with any number from this bench.** Neither CLI's tool list is
restricted — each CLI's own search stack is the thing under test, so a
`--tools` gate would answer the question by fiat. Both arms keep their shipped
headless defaults (permission mode, caches), so this prices the PRODUCTS, not
one isolated feature. Arm order alternates per rep; at `--reps>=3` the summary
prints cost RANGES and the claim only stands because they do not overlap. Both
CLIs edited two decoy files in most runs (comments naming the old function) —
that is the soft flag, not a failure; the hard decoy checks never broke.

See [[token-bench-measurement-traps]] for the stream-vs-transcript undercount
this bench found (claude's stream output was 17.9x low), and
[[build-tool-ab-directory-gap]] for the single-binary A/B it borrows its
protocol from.
