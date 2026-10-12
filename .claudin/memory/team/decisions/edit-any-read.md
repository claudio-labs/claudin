---
name: edit-any-read
description: Edit takes Patch's in-place read rule since 2026-10-12 - any read authorizes it, a never-read file is edited when old_string occurs exactly once (result says unread); partial-view, stale and coverage refusals, served regions and the call() staleness throw deleted, no killswitch
type: project
scope: tools/FileEditTool
impact: functional
paths:
  - "src/tools/FileEditTool/FileEditTool.ts"
  - "src/tools/shared/readBeforeEditMessages.ts"
---

**Decision:** Edit follows the rule Patch has had since 2026-09-24/29
([[apply-patch-any-read]], [[patch-applies-what-matches]]). `validateInput`
refuses only a file with no `readFileState` entry whose `old_string` does not
occur in it exactly once (`locateExactText`, no quote or whitespace fuzz);
`call()` re-checks that against the bytes it replaces. Any read — outline,
range, symbol, clipped, injected, changed on disk — authorizes the edit, and
`old_string` matched against the file as it is now decides it. A never-read
edit that applies says so in the result (`unread` in the output, the shared
`appliedUnreadNote`). The rule and its wording live once, in
`readBeforeEditMessages.ts` ("In-place writes"); Write and NotebookEdit keep
the whole-file gate. Not-found now gives Patch's divergence message
(`shared/blockMismatch.ts`).

**Why:** user decision on 2026-10-12, after the census
([[edit-write-error-census-2026-10-12]]): 19 of Edit's 22 errors that week were
its own read lanes, every one an exact unique match, 14 resubmitted
byte-identical; the coverage lane also re-refused an identical resubmit
(trailing-newline bug). No paid A/B: ~19 refusals/week is below the session
A/B noise floor ([[bash-read-passthrough-not-promoted]]).

**What changes for a teammate:**
- An Edit after an outline or a range, or on a file only seen via Bash/Grep,
  applying is intended. `readGateScenarios` S20 pins it; the refresh
  mechanics S1–S16 are now observed through Write.
- Do not bring back a partial/stale/coverage refusal for Edit without a
  measurement that says it buys something (`.claudin/rules/cache.md`).
- The Edit tool description changed (any Read counts) — one cache-prefix
  change at upgrade.

**Rejected:** a killswitch for the old gate (it would keep the deleted lanes
alive); a paid session A/B (above).

**Evidence:** branch `fix/edit-write-census`; live `claudindev -p` (Sonnet) in
a throwaway repo — cat→Edit applied with the unread note, Read(range to EOF)
→Edit with a trailing `\n` applied first try, a non-matching unread Edit was
refused with the reason; break-probes in
`scripts/migrations/probes/editWriteCensus.json`.
