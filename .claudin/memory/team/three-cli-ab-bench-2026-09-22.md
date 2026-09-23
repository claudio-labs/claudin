---
name: three-cli-ab-bench-2026-09-22
description: Three-arm CLI A/B (released claudin 1.1.33 vs claudindev vs Claude Code 2.1.278) on a 15-file search→read→edit→build task, N=3, 2026-09-22 — what separated, what tied, and why the 08-12 cost gap is gone
type: project
---

`scripts/bench/ab/three-cli-ab.ts`, built 2026-09-22 as the three-arm sibling of
`cli-search-edit-ab.ts` (same protocol, same `cliUsage.ts` accounting). Two
differences are the point: the **released** binary and the working tree are
arms alongside Claude Code, and the fixture is sized so each lane of the
workload is a number the grader can check — 15 `.js` files of which **exactly
ten mention the target symbol and exactly five must change**.

`--dry-run` has seven gates (fixture shape, pristine green, pristine fails the
grade, reference solution passes touching exactly 5 files, one missed site goes
RED, an unused-parameter rename is caught, a blind `s///g` trips the decoys) and
costs zero model tokens. `--replay=<json>` re-renders the tables from a saved
run, which is how a reporting change is checked without paying for the bench.

**Result — N=3, Sonnet 5 pinned on all three, 9/9 runs PASS, all with exactly
the five required edits and no decoy damage.** Equal work, so the deltas mean
something.

| median | claudin 1.1.33 | claudindev | claude 2.1.278 |
|---|---|---|---|
| cache_creation (write) | 13.2k | 13.2k | 20.7k |
| cache_read | 218.7k | 218.6k | 160.3k |
| cache reuse | 94.3% | 94.3% | 88.9% |
| first-turn context | 32.6k | 32.6k | 32.4k |
| peak context | 37.8k | 37.0k | 39.3k |
| input (uncached) | 14.6k | 13.9k | **10** |
| turns / tool calls | 15 / 14 | 11 / 10 | 18 / 17 |
| cost (CLI) | $0.1504 | $0.1473 | $0.1462 |

Separation is reported **pairwise**, and it has to be: two of the three arms are
the same product one commit apart, so a single "some overlap" verdict over all
three masks a real result. SEPARATED → `cache_creation` (Claudin 12.5–13.2k vs
claude 19.8–21.2k), `peak context` (all three disjoint), `tool calls` (10–15 vs
17–19). OVERLAP, so **no claim** → cost ($0.134–$0.173 spans every arm) and
`cache_read`.

**This supersedes the headline of [[cli-search-edit-ab-bench]].** That bench
measured claude at **70.5k first-turn context and +86% cost** on 2026-08-12.
Six weeks later its prefix is **32.4k — level with Claudin's — and cost is a
statistical tie.** The prefix is not fixture-dependent (nothing is read at turn
1), so this is a real Claude Code change, not the bigger fixture. Do not quote
the old cost gap.

What still separates is **shape, not price**: Claudin landed all five edits in
ONE `apply_patch` and used Grep to discard five of the ten candidates without
opening them (5 reads); Claude Code read all ten and issued five separate
`Edit`s (10 reads, 5 edits), which is the 18–20 turns against 11. Claudin's
lower cache_creation with a HIGHER uncached `input` (14k vs claude's ~10 tokens)
is the defer-cache-marker leaving a tail uncached instead of paying a write —
see [[defer-cache-marker-shipped]]. At $3/M uncached against $3.75/M written the
two roughly cancel, which is why the cost column ties.

**Caveats to carry with any number here.** `claudin` and `claudindev` were ONE
commit apart (v1.1.33 → 802a2f07), so treat dev/rel deltas as noise — with one
observation worth keeping: claudindev was perfectly stable (11 turns, 10 calls,
13.2k write in all three reps) where the released binary varied 11–16 turns.
Both Claudin arms ran with the user's real `~/.claudin/settings.json`
(`effortLevel: high`, `frontend-design` plugin), with no equivalent pinned on the
claude side; this prices the PRODUCTS as configured, not one isolated feature.
See [[token-bench-measurement-traps]] for why the stream and the transcript are
merged rather than one falling back to the other.
