---
name: tests-observing-through-telemetry
description: Deleting an analytics event silently hollows every test that used it as its observation channel — the fix is to give the code a real decision record, not to delete or weaken the test
type: feedback
---

Found five times in one session (2026-09-15, [[dead-code-cleanup-2026-09-15]]).
A test mocks `logEvent`, captures the emitted payload, and asserts on fields
that exist nowhere else. Delete the event and the assertion does not go red —
it goes **vacuous**, or it fails for a reason that reads like a test bug.

**Why:** in this fork `logEvent` reaches an empty function
(`no-telemetry-plugin.ts`), so that channel only exists inside the test process.
The test was never observing shipped behaviour; it was observing a report about
behaviour that nothing receives.

**How to apply.** When a removal makes a test fail on a captured event, sort it
into one of three cases before touching anything — the answer differs:

- **The event was the only view of a real internal decision.** Give the code a
  local decision record and point the test at it. `toolResultSummarizer` had 27
  tests reading `strategyId`, `errorWindowPreserved`, `salientPinned` and the
  token estimates off its event; they now read `getLastSummaryDecision()`. Two
  details the conversion nearly lost, both caught by the tests: keep a field
  **absent** rather than `false` when the strategy has no such concept, and keep
  a **count** the code already computes instead of the boolean the analytics
  payload flattened it to. The record says strictly more than the event did.
- **The event stood in for a check the test already makes.** Delete the event
  assertion only. `resumeSession` asserted
  `logEvent:session_resumed:false` on a line directly under
  `rejects.toThrow('boom')`.
- **The test's whole subject was the telemetry.** Then it has nothing left to
  assert and should be rewritten around what the user experiences, or deleted
  with that stated. `auth-code-listener.analytics.test.ts` became
  `.errorRedirect.test.ts` asserting the response is ended and the pending
  reference dropped — strictly stronger than asserting a report was filed.

Two shapes worth knowing: a test can read the **production file as text** and
assert a `logEvent(` call exists in it (a claim about telemetry, not about the
feature — delete it), and four tests can sit in a file where only one carries a
behavioural claim worth keeping.
