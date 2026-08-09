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

**1,809 events, 504 distinct files, none above 3k lines.** `src/utils/log.ts`
is 11 KB against a 10 MB cap and got the message 66×. For 107 of those paths
another read in the same session returned the full body, so the claim is
provably false in the transcript itself (832 events, 46%).

A test *pinned the bug*: `autoOutlineOnElision.test.ts` asserted
`toContain('exceeds the read cap')` on the pivot result.

## The pivot itself is NOT broken — do not "fix" it again

Of the 1,809: 27.4% needed no follow-up, 17.3% followed with `symbol=`, 40.6%
with a range (**58% of those land within 3 lines of a symbol start the outline
listed — 391 at gap 0**, i.e. the designed two-step working), 13.7% with
`view='full'`, 0.8% a bare repeat. Honest split: **68.3% works, 31.5% fails.**

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
