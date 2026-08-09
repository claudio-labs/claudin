---
name: auto-outline-pivot-false-cap-claim
description: Measured 2026-08-09 — the auto-outline pivot told 504 real source files they "exceed the read cap" when none did (1,809 events); the pivot itself works 68.3% of the time, so only the message was broken
type: project
---

Census over 2,052 local transcripts / 24,741 Read calls, run 2026-08-09 while
deciding whether to keep PR #67 (closed) or retarget. Fixed on branch
`fix/auto-outline-pivot-false-cap-claim`.

## The bug

`makeOutlineData` took `overCap: boolean, autoPivot = false` — four
combinations for three real states, one of them meaningless. Both the
threshold pivot and the genuine over-cap fallback passed `overCap=true`, so
`renderOutline` emitted **"exceeds the read cap"** for a file that had merely
crossed the 250-line / 10k-char auto-outline threshold. It contradicted
`AUTO_OUTLINE_PIVOT_FOOTER` two lines below ("File is large; returned outline
instead of full body") and told the model the body was out of reach when
`view='full'`, `offset/limit` or `symbol` returns it. (A *plain* re-read pivots
again — the trigger is deterministic — so the cap wording was wrong about the
**reason**, not about the repeat. An earlier draft of this memory and of the
commit message had that backwards.) Collapsed into a single `OutlineReason`
discriminator
(`'explicit' | 'overcap' | 'pivot'`) so the cap wording is reachable only from
the `catch` arm where the error was actually thrown.

**1,809 events, 504 distinct files, none above 3k lines** — but treat that as
an UPPER bound. Because both arms emitted the same string, the detector cannot
separate a threshold pivot from a genuine cap hit, and the ≤3k-line filter does
not do it either (a file that really blows the 25k-token cap at ~35 chars/line
sits near 2,850 lines). The sub-claim that survives unaided: for **107 paths**
another read in the same session returned the full body, which is a real
falsification — those cap claims were false in the transcript itself.

A test *pinned the bug*: `autoOutlineOnElision.test.ts` asserted
`toContain('exceeds the read cap')` on the pivot result.

Its replacement then repeated the shape in reverse and review caught it: the new
test asserted `toContain('is large')` on the **rendered** result, but the footer
itself reads "File is large…", so the assertion passed with the entire pivot
branch deleted from the header. Assert a header claim on the pre-footer payload
(`data.file.content`), never on output that has a suffix appended. Same round:
running a mutation against only the test files the diff touched certified an
"unguarded" line that a third file already guarded. Both belong in
`.claudin/rules/agent-safety.md` §4 next to the other green-test-guards-nothing
traps whenever that rule is next edited.

## The pivot itself is NOT broken — do not "fix" it again

Of the 1,809: 27.4% needed no follow-up, 17.3% followed with `symbol=`, 40.6%
with a range (**58% of those land within 3 lines of a symbol start the outline
listed — 391 at gap 0**, i.e. the designed two-step working), 13.7% with
`view='full'`, 0.8% a bare repeat.

**Cite the range 40.8%–68.3%, not the point 68.3%.** The upper bound counts the
whole no-follow-up bucket as success, and that bucket also holds end-of-session,
user interrupt, and the model giving up — 40% of the claimed "works" is that one
assumption. The lower bound drops it entirely. The size gradient below inherits
the same circularity, so it is suggestive, not established.

The earlier framing "28.1% need a second Read = degradation" is wrong — most
second Reads are the design working. Counting any follow-up as failure will
re-manufacture a phantom problem.

Hypotheses the data **refuted**: that the header mis-ranks its hints (both
lanes work, no signal the order is wrong). Real residue worth a look: **164
pivots turn into a slice-walk** (3+ consecutive range reads on one file) —
the exact loop AGENTS.md says the pivot exists to prevent — and the footer's
advice "Use `view='outline'` explicitly to map further" is useless to a caller
already holding the outline, while `view='full'` is never advertised at all.
Both left alone deliberately: changing guidance text is a behavior change with
no measurement behind it yet.

**The two triggers are collinear, so the census cannot separate them.** 250
lines × ~40 chars/line ≈ 10,000 chars: on ordinary source they fire together by
construction. The measured 95.6% overlap therefore says the LINE trigger is
redundant — not that moving the char threshold would change any outcome.

## Live A/B (2026-08-09, N=6, corrected) — the pivot buys context with latency

`scripts/profile/read-outline-pivot-ab.ts`, claude-sonnet-5, five real files
21.0-21.9 KB / >250 lines, comprehension task. Two independent N=3 runs pooled
(`read-outline-pivot-ab.run1.json` + `.json`). Both clean: 0 toolset escapes,
sentinel 3/3 both arms, arm order alternated per rep.

**Report these per metric — four separate perfectly, cost does not.** p is an
exact two-sided Mann-Whitney; **0.0022 is the FLOOR for 6v6**, so it means
total separation and nothing stronger is expressible at this N.

| | pivot ON (n=6) | pivot OFF (n=6) | median | p |
|---|---|---|---|---|
| assistant turns | 5,6,7,7,7,9 | 2 ×6 | 3.50× | 0.0022 |
| Read calls | 20-26 | 5 ×6 | 4.60× | 0.0022 |
| end context | 36.7k-59.2k | 63,057-63,058 | **−24.5%** | 0.0022 |
| wall time | 78-95 s | 38-62 s | **1.99×** | 0.0022 |
| cost USD | .257-.430 | .204-.312 | 1.31× | **0.026** |

So the pivot **delivers on its stated purpose** — ends 24.5% smaller while
moving ~35% fewer result chars — and pays in round-trips: 4.6× the Read calls,
17-19 repeat reads vs 0, **2× wall time**. Latency is the headline cost, and it
is the cleanest result in the table.

**On cost, state the caveat with the number.** Ranges still overlap at N=6 and
p=0.026 does **not** survive Bonferroni over the five metrics tested (α=0.01).
What supports it instead is reproducibility: 1.30× / 1.30× / 1.31× across two
independent runs and the pool. Cite it as "~1.3×, marginal", never as a clean
finding. Note also that pivot-OFF end context is essentially deterministic
(63,057-63,058 across all six), so any spread in that column is the pivot's.

Answers were equivalent in substance in both runs — all five questions, same
files, same functions and line numbers where spot-checked.

**A "quality signal" from run 1 did not reproduce; this is why the second run
mattered.** Run 1 had pivot-OFF citing file:line 2-3× more often in every rep
(43/53/17 vs 14/16/11) and it was written down here as consistent and
unexplained. Run 2 came back 23/48/7 vs 25/47/13 — no gap at all. Pooled, the
medians still differ (33 vs 15) but the ranges interleave completely and
p=0.310. It was noise. Three reps agreeing inside ONE run is not
reproducibility; only an independent re-run tells you that.

**Two earlier numbers from this same bench were wrong; do not resurrect them.**
A first pass reported 2.01× (dedup kept the first `output_tokens` per message
id, which grows as the message streams), then 2.35× (still N=1, arm order
fixed, and arm A had escaped its toolset through Grep). The traps are
generalizable and live in [[token-bench-measurement-traps]] — read that before
trusting any delta here. The gate that finally worked is `--tools Read,Glob
--strict-mcp-config`: `--allowedTools` is a permission allowlist that never
reaches the registry, so it leaves all 40 tools visible.

**The fixture design is adversarial to the pivot — read ~1.8× as a CEILING on
the latency penalty, not a typical value.** The script picks "one question per
fixture, each answerable only from the implementation — not from a signature",
reasoning that an outline-answerable question would hand the pivot arm a free
win. That excludes the pivot's best case by construction: the census measured
**27.4% of reads needing no follow-up at all**, and this bench forces that
bucket to 0%. The size band compounds it — 21.0-21.9 KB, chosen so both
triggers fire, while the census puts the pivot's payoff at 40k+. Both choices
push the same way.

Fixing it means a mixed question set (some outline-answerable, some not) in the
census's real proportions, plus a 40k+ band. Until then the between-arm
comparison is fair (same five files copied byte-for-byte, same questions, same
model, alternating order) but the absolute penalty is a worst case, and this
says nothing about the 10k-char threshold specifically since the fixtures trip
the line trigger too.

## Method (the trap that cost an hour)

An auto-pivot does **not** render "Structural outline of" — it renders the
**over-cap** lead, so the obvious detector returns zero. Match
`bare Read input (no view/symbol/offset/limit) -> result containing "exceeds
the read cap"`. A footer-based detector gives 1,699 for the same population;
cite the detector with the number. Transcripts at
`~/.claudin/projects/**/*.jsonl`; pair `tool_use.id` → `tool_result.tool_use_id`
and key sequences by `(file, isSidechain)` so sub-agent reads don't create
false follow-up pairs.

Probes of the pivot **cannot** run under `bun test` without
`CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION=1` — the test preload stubs every
`feature()` to false, so a naive probe silently falls through to the body.

See [[bash-file-read-census-and-redirect-reach]] for the corrected error-path
numbers this replaced.
