---
name: bash-read-passthrough-not-promoted
description: CLAUDIN_BASH_FILE_READ_PASSTHROUGH + CLAUDIN_BASH_READ_CREDIT stay OFF (2026-09-23) — they passed the pre-registered median gate, but a placebo arm matched them; the model re-Reads anyway and the credit dies on --resume. Round 2 (09-24) fixed both blockers and the credit engages; promotion pending
type: project
scope: bash/output-filter
impact: rejected
paths:
  - "src/tools/shared/outputFilter/Bash/fileReadShape.ts"
  - "src/tools/BashTool/creditShownFiles.ts"
---

**Decision:** Both flags stay in the code with default OFF (user decision,
2026-09-23, branch `perf/session-cache-round-2`). The pass-through leaves a pure
`for f in …; do cat $f; done` read whole up to 28k chars instead of the floor
cap's 15+15 lines; the credit counts each file such a read printed whole as a
Read for the read-before-edit gate.

**Why:** In the session A/B (`scripts/bench/ab/session-cache-ab.ts`, run
`/tmp/session-cache-ab/20260923-155324`, N=5, all 20 runs 18/18) the `readcat`
arm (both flags) passed its pre-registered gate on medians — tool calls −16%,
turns 23→19, tool-result chars +2%, cost −4% (overlap). But the `credit` arm
alone got turns −17%, tool calls −12%, cost −6%, and in its 10 runs the credit
never let a single edit through: the model Read every file before editing it,
as the Edit/apply_patch contract tells it to, so nothing it saw differed from
baseline. That arm is a placebo, and the readcat numbers sit inside what it
moved. The mechanism did not engage: after a whole pass-through the model
re-Read the same files (r1: 6 of them; r5: Read×10 after 48.6k chars of
pass-through), and the credit lives in the process's `readFileState`, so a
`--resume` starts without it (readcat r1's one refusal was phase 2's first patch
on a file only `cat`'d in phase 1). On the recorded Bash corpus the pass-through
gives back 0.9% of the cap's savings (18k of 2.0M chars).

**What changes for a teammate:**
- Don't flip these on a median. They need the model to treat a Bash read as a
  read — the tool contract has to say so — and the credit to be rebuilt on
  resume from the transcript like Read entries are.
- A session-A/B arm whose mechanism provably never fired is this bench's noise
  floor at N=5: −17% turns, −6% cost. A median gate like "≤ −15% tool calls"
  passes on noise; add a placebo arm, or require SEPARATED.
- The credit itself works in the built CLI: a mock-model end-to-end run (Bash
  loop, then `apply_patch` with no Read) succeeds with the flag and is refused
  without it.

**Rejected:** promoting on the pre-registered gate alone (above); removing the
code (kept, off, for a follow-up that fixes the two blockers).

**Evidence:** run dir above; `credit-evidence` analysis (edits that succeeded
with no prior Read: 0 of 10 runs); the review fixes that tightened the credit
(dated before the run, measured as sent, inside the working directories).

**Round 2 — both blockers fixed (2026-09-24, branch `perf/cat-read-and-batch-read`,
9e8c469b).**
- The result says it: a pure read comes back byte-exact in `<bash-output-read>`,
  and a Bash result that printed files whole ends with
  "(N files printed whole — they count as read: …)".
- The Edit/Patch/Write contract and the Anthropic addendum name it, behind the
  credit flag.
- `creditedFiles` rides on the Bash result, and `/resume` rebuilds it
  (`queryHelpers.ts`).
- The `cat` segments of any command credit, not only pure reads.
- An over-budget read keeps the whole files that fit and names the rest,
  instead of a `<persisted-output>` preview.

In the 5-arm A/B the model stopped re-Reading: 1 Read median against 19, zero
Reads of a credited file, the credit engaged in 4/5 runs. The pre-registered
turn and tool-result-chars gates still missed —
[[cat-read-and-batch-read-ab-2026-09-24]]. Whether to flip the defaults is the
user's call; until then both flags stay off.

**Round 3 — still off (2026-09-24, d444c515).** A leading `cd` and
`head`/`tail` prints now count, which closed the two grammar misses the A/B
showed. Measured on top of the batch Read, now on by default
([[batch-read-default-on]]), the credit cost +6% and added 2 API calls. The
model reads by batch Read and seldom by `cat`. The flags stay off — parked,
not dropped: the user plans to come back to it (2026-09-24).
