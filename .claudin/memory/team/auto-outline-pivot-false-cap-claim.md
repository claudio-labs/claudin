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
instead of full body") and told the model the body was unreachable when a
plain re-read returns it. Collapsed into a single `OutlineReason` discriminator
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

## Live A/B (2026-08-09, N=1 — indicative only)

`scripts/profile/read-outline-pivot-ab.ts`. Five real files, 21.0-21.9 KB, all
over 250 lines, comprehension task, claude-sonnet-5. Pivot ON cost **2.35×**
pivot OFF ($0.578 vs $0.245) on **12 assistant turns vs 3**, while moving 30%
FEWER result characters (84k vs 120k). The pivot trades characters for
round-trips and the round-trips cost more. Answers were equivalent.

Three caveats that bound it: N=1 against the N≥3 the rules require; the fixtures
sit in the census's WORST band and never the 40k+ band where the pivot looks
good; and `--allowedTools` is a permission gate, **not** a registry filter — arm
A escaped through Grep twice. What the run does support is the mechanism (9
extra sequential turns, visible in the transcript). What it does not support is
any cost multiple, or anything about the 10k-char threshold specifically, since
the fixtures trip the line trigger too.

Two measurement traps this bench hit, both worth re-checking in any transcript
bench: the transcript writes ONE LINE PER CONTENT BLOCK sharing `message.id`,
where `input`/`cache_*` repeat but `output_tokens` GROWS — summing every line
inflates input, keeping the first undercounts output by up to 100×, and neither
error is uniform across arms. Take the max per id. And whichever arm runs first
pays the cold prompt cache; the second inherits the warm prefix even from a
different cwd (~19% of the gap here), so alternate the order.

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
