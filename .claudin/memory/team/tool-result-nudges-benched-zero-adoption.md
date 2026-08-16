---
name: Appended <system-reminder> nudges benched at zero adoption
description: SERIAL_READ_NUDGE was killed on merit (adoption 0); prefer removing structural friction over persuading the model, and land new nudges flag-OFF as bench instrumentation
type: feedback
---

A `<system-reminder>` appended to a `tool_result` to talk the model out of an
anti-pattern has been **measured in this codebase and did not work**. Prefer
changing what the tool *does* (or what its refusal message *says*) over adding
another reminder. If a nudge is still worth having, land it with its
`feature()` flag **OFF** as instrumentation for an A/B, not as shipped behavior.

**Why:** `SERIAL_READ_NUDGE` (`scripts/build/build.ts`, detector in
`src/tools/FileReadTool/serialReadNudge.ts`) shipped to nudge the model into
parallel Reads / the Explore agent. The 2026-06-10 re-bench killed it: -6.3%
narration against a -30% ship bar, and — the damning number — **adoption zero**
(`parallel=0`, `explore 0/3`). The code at `FileReadTool.ts:1364` is still
there but dead in the bundle. `SERIAL_EDIT_NUDGE` (2026-07-25,
`src/tools/shared/serialEditNudge.ts`) was written the same way and deliberately
shipped OFF for that reason.

**How to apply:** before proposing a reminder-style intervention, grep
`scripts/build/build.ts` for the nearest flag and read its comment — several carry the
bench verdict that killed them. When the goal is to change model behavior, look
first for the friction pushing it the wrong way. The 2026-07-25 case is the
model: `apply_patch` refused an outline-read file with "has not been read yet",
which is false and hides the fix, so the model settled for one patch per file.
Splitting that refusal into never-read / partial-view / clip-stuck branches is
causal; the nudge was not.

Second confirmed instance (2026-07-25): the model kept running `bun test` in
Bash despite RunTests being loaded (not deferred) and its description already
saying "Prefer this tool over Bash". Two structural fixes, no nudge — a
`Run tests: Use RunTests` line in BashTool's own "Prefer:" list (the list the
model reads at the moment it reaches for Bash, which enumerated Glob/Grep/Read/
Edit/Write but not tests), and a one-shot refusal in BashTool `validateInput`
(`src/tools/RunTestsTool/redirect.ts`). Verified live via
`node dist/cli.mjs -p … --output-format stream-json --verbose`: the plain ask
now goes straight to RunTests, and forcing Bash yields the refusal, then runs
on the re-send. **Any behavior change of this kind should be verified that way**
— a source-text wiring test cannot tell you the model actually complied.

Third instance, and the cleanest of the three (2026-08-09, PR #69): the pivot
footer never named `view='full'`, so the obvious hypothesis was that the model
sliced files because it did not know the escape existed at that point. Adding
`Pass view='full' to load the whole body in one call` to the footer moved
adoption from 1/4 (baseline, no hint) to **1/6**. Thirty pivots served the
explicit instruction; the model used it once. Cost, cache and context all landed
inside the noise floor. Naming an option does not create adoption — that is now
measured three times, and "the model doesn't know X exists" should be treated as
a hypothesis to falsify rather than a diagnosis.

What the run did explain is *why*, and it reframes the target. The model uses
the outline correctly at first (symbol reads, turns 2-3) and only then degrades
into `offset/limit` slicing (turns 4-7, six to nine reads of one file). The
footer is seen **only at turn 1** — slice reads return a body and carry no
footer — so the instruction is three to six turns stale by the time the decision
it targets happens. Placement, not vocabulary. Untested: the A/B varied presence,
not timing. See [[token-bench-measurement-traps]] for the guard that made this
negative result trustworthy.

Caveat worth carrying: when you split a refusal by cause, verify each branch's
**remedy** against the code rather than assuming a distinct cause implies a
distinct fix. The first version of this split told the clip-stuck branch that
`view='full'` was NOT the answer and a plain re-Read would re-arm the body. Both
the sticky-replay guard (`FileReadTool.ts:763`) and the auto-outline pivot
(`:2195`) key on `view === undefined`, so `view='full'` is exactly what escapes
them, and a plain re-Read replays the same outline for `STICKY_REPLAY_BUDGET`
reads. The message was steering the model back into the loop it was written to
break — caught only by a review agent that read the guards.
