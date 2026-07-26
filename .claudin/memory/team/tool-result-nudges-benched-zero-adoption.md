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

**Why:** `SERIAL_READ_NUDGE` (`scripts/build.ts`, detector in
`src/tools/FileReadTool/serialReadNudge.ts`) shipped to nudge the model into
parallel Reads / the Explore agent. The 2026-06-10 re-bench killed it: -6.3%
narration against a -30% ship bar, and — the damning number — **adoption zero**
(`parallel=0`, `explore 0/3`). The code at `FileReadTool.ts:1364` is still
there but dead in the bundle. `SERIAL_EDIT_NUDGE` (2026-07-25,
`src/tools/shared/serialEditNudge.ts`) was written the same way and deliberately
shipped OFF for that reason.

**How to apply:** before proposing a reminder-style intervention, grep
`scripts/build.ts` for the nearest flag and read its comment — several carry the
bench verdict that killed them. When the goal is to change model behavior, look
first for the friction pushing it the wrong way. The 2026-07-25 case is the
model: `apply_patch` refused an outline-read file with "has not been read yet",
which is false and hides the fix, so the model settled for one patch per file.
Splitting that refusal into never-read / partial-view / clip-stuck branches is
causal; the nudge was not.

Caveat worth carrying: when you split a refusal by cause, verify each branch's
**remedy** against the code rather than assuming a distinct cause implies a
distinct fix. The first version of this split told the clip-stuck branch that
`view='full'` was NOT the answer and a plain re-Read would re-arm the body. Both
the sticky-replay guard (`FileReadTool.ts:763`) and the auto-outline pivot
(`:2195`) key on `view === undefined`, so `view='full'` is exactly what escapes
them, and a plain re-Read replays the same outline for `STICKY_REPLAY_BUDGET`
reads. The message was steering the model back into the loop it was written to
break — caught only by a review agent that read the guards.
