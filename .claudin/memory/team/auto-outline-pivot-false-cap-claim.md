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

## Live A/B (2026-08-09, N=3, corrected) — the pivot buys context with latency

`scripts/profile/read-outline-pivot-ab.ts`, claude-sonnet-5, five real files
21.0-21.9 KB / >250 lines, comprehension task. Clean run: 0 toolset escapes,
sentinel 3/3 both arms, arm order alternated per rep.

**Report these four separately — three separate cleanly and one does not.**

| | pivot ON | pivot OFF | separated? |
|---|---|---|---|
| assistant turns | 7,7,7 | 2,2,2 | **yes**, no overlap |
| end context | 36.7k / 51.2k / 53.1k | 63.1k ×3 | **yes**, −18.8%, no overlap |
| wall time | 78/95/86 s | 47/40/62 s | **yes**, ~1.8× slower |
| cost USD | .257/.344/.360 | .265/.258/.312 | **NO — ranges overlap** |

So: the pivot **delivers on its stated purpose** (ends 18.8% smaller, moving
30% FEWER result chars — 84k vs 120k) and pays for it in round-trips: 24 Read
calls vs 5, 19 repeat reads vs 0, ~1.8× wall time. Median cost is 1.30× but the
cheapest pivot-ON run beat the priciest pivot-OFF one, so **do not cite a cost
multiple** — at N=3 cost is a wash and latency is the real price.

Answers were equivalent in substance (all five questions, same files, same
functions and line numbers where spot-checked), but pivot-OFF cited file:line
2-3× more often every rep (43/53/17 vs 14/16/11) — consistent, unexplained,
and the one quality signal that favors the full body.

**Two earlier numbers from this same bench were wrong; do not resurrect them.**
A first pass reported 2.01× (dedup kept the first `output_tokens` per message
id, which grows as the message streams), then 2.35× (still N=1, arm order
fixed, and arm A had escaped its toolset through Grep). The traps are
generalizable and live in [[token-bench-measurement-traps]] — read that before
trusting any delta here. The gate that finally worked is `--tools Read,Glob
--strict-mcp-config`: `--allowedTools` is a permission allowlist that never
reaches the registry, so it leaves all 40 tools visible.

Still **not** answered: the fixtures sit in the census's worst band and trip
the line trigger as well as the char one, so this says nothing about the 40k+
band or about the 10k-char threshold specifically.

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
