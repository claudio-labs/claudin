---
name: edit-then-and-cap-keep-paths-default-on
description: Since 2026-09-25 Patch and Edit take `then` (up to 3 check commands run after the edit, in the same call) and the Bash cap keeps the path lines of a listing — both ON by default (CLAUDIN_EDIT_THEN=0 / CLAUDIN_CAP_KEEP_PATHS=0); `then` also arms the response guard by default
type: project
scope: src/tools/shared/editThen/, src/tools/shared/outputFilter/Bash/floor.ts, src/agent/tools/responseChain.ts
impact: functional
paths:
  - "src/tools/shared/editThen/editThenShape.ts"
  - "src/tools/shared/editThen/editThen.ts"
  - "src/tools/shared/outputFilter/Bash/floor.ts"
  - "src/agent/tools/toolOrchestration.ts"
---

**Decision:** two request-count levers are on by default since 2026-09-25
(branch `perf/request-count-round-4`, commit 67541d95).
- `then` on Patch and Edit: up to 3 shell commands run once the edit applies,
  in order, stopping at the first failure; their output rides the edit's
  result. `CLAUDIN_EDIT_THEN=0` removes the field, the prompt line and the guard
  it arms.
- The Bash floor's 15+15 cut keeps every middle line that is only a path
  (`git ls-files`, `find`, `wc -l`), up to 200. `CLAUDIN_CAP_KEEP_PATHS=0`
  restores the plain cut.

**Why:** one API request is one model response, so only merging *sequential*
steps saves requests, and prompt text never moved that
([[request-count-levers-2026-09-24]]). Round-4 session A/B
`/tmp/session-cache-ab/20260925-153340` (N=8, Opus 5.5 medium, placebo arm):
`then` was used in 8/8 sessions, calls −14% vs base and placebo, a test run
alone after an edit 4 vs 9; pathcap left 0/8 late reads of a listed file (base
5/8). The user promoted both the same day.

**What changes for a teammate:**
- The response guard (`responseChain.ts`) is now armed by default, because
  `then` arms it: a non-read-only Bash/Git or a check behind a failed call in
  the same response comes back `Skipped:`. A test or E2E control that means
  "nothing stops the commit" must set `CLAUDIN_EDIT_THEN=0`.
- `then` runs only where no dialog would open (bypass, auto, or an allow rule)
  and with no PreToolUse/PostToolUse hooks; elsewhere the edit applies and its
  result says why the commands did not run. In default mode without allow
  rules it buys nothing.
- Bench base arms now carry both; pass `=0` to measure the old behavior.
- The Patch and Edit descriptions gained one line each (snapshots updated).

**Rejected:**
- Refusing the call in `validateInput` where `then` cannot run: that costs the
  same round-trip `then` exists to save.
- `CLAUDIN_GREP_BODIES` (built in the same round): 0 uses in 13 sessions; the
  models search in `content` mode, never `symbols`. Parked, off.

**Evidence:**
- `src/tools/shared/editThen/editThen.test.ts`, `src/agent/tools/toolOrchestration.test.ts`,
  `src/tools/shared/outputFilter/Bash/floor.test.ts`: the default unset and `=0`;
- `scripts/bench/ab/response-chain-e2e.ts` scenarios 3 and 14-19 on the bundle;
- `scripts/migrations/probes/editThen.json` and `capKeepPaths.json`, every
  probe red, including "off by default again" and "`=0` ignored".
