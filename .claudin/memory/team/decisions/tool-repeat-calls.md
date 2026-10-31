---
name: tool-repeat-calls
description: Since 2026-10-31 Grep also reads a slash glob from the search path, WaitFor waits up to 1800 s in one call (CLAUDIN_WAITFOR_MAX_TIMEOUT_S=600 reverts), and RunTests/Typecheck/Build/WaitFor carry call forms, which the user kept on a literal cost-gate FAIL that sat inside the placebo's noise
type: project
scope: src/tools/GrepTool/globAnchor.ts, src/tools/WaitForTool/limits.ts, src/tools/ToolSearchTool/prompt.ts, src/agent/tools/toolExecution.ts
impact: functional
---

**Decision (user, 2026-10-31).** The goal was to cut repeated calls without blocking any use: no new refusal or redirect.
- **Grep, a bug fix with no killswitch.** ripgrep anchors a glob holding `/` at the directory it runs in, which is the session cwd. Under any other `path`, `src/*.ts` matched nothing. `globsForSearchPath` now passes the glob as written and also led by the search path. Positive globs match either reading and negated ones exclude both, so nothing that matched on main stops matching. The first version replaced the glob and broke `!node_modules/` and cwd-written globs; the review caught it.
- **WaitFor's cap is 1800 s**, the Monitor's 30 min, where it was 600 s. The schema, the call form and the Bash sleep advice state the cap set when `limits.ts` loads. Each call is also clamped by the live value, so a killswitch applied later by settings.json still caps the waits.
- **Call forms on RunTests, Typecheck, Build and WaitFor.** All four stay deferred. A form shows the common call; a parameter it leaves out still validates, but the model has to load the schema to learn it. Bash's advice no longer tells the model to ToolSearch a tool that has a listed form (`hasListedCallForm`). `CLAUDIN_DEFERRED_CALL_FORMS=0` turns off these forms together with #330's.
- **Left out, with measured value:**
  - a per-turn classifier cache, worth 29 calls a week, 18 of them WaitFor re-polls that the cap already removes;
  - Bash↔Read permission parity, worth 24 calls a week;
  - edit chains, kept batched as decided in #314;
  - Explore reports re-read by the parent, which cost tokens, not calls.

**Why (Opus 5.5 medium, N=5):**
- **Long wait** (`waitfor-adoption-ab.ts --long`, a 50 s wait): base and placebo, both at a 20 s cap, made 3 WaitFor calls in every rep, median 4 API calls, $0.087 and $0.088. The lever, at a 60 s cap, made 1 WaitFor in every rep, median 2 calls, $0.070. It asked for more than the base cap in all 5 reps. PASS.
- **Forms** (`tool-gaps-ab.ts --only=main,current,current-placebo`):
  - correctness PASS, 115/115 in every arm;
  - loads NO HEADROOM: main never loads these tools on this fixture since #330;
  - cost FAIL as registered: branch $1.324 against main $1.237 and placebo $1.226. The placebo is the same build as the branch, so an 8% gap is the noise band;
  - RunTests was used in 4 of 10 branch sessions against 0 of 5 on main, and Bash `bun test` runs went 18 → 9 and 8.
- **Context:** the first request grew by about 90 tokens (17,245 → 17,337), because the deferred listing went from 605 to 836 chars.
- **Census baseline, 10-25..31:**
  - 24 of 28 slash-glob Greps under another path came back empty. Replayed through the fix, 22 of the 24 match, and the other 2 have no match on disk.
  - 35 WaitFor re-polls, 29 of them after a timeout. CI polls: 30, of which 25 timed out.

**What changes for a teammate:**
- `feature-usage-census.ts` counts slash-glob empties and WaitFor re-polls; the `/census` skill runs it once per project.
- A new deferred tool whose common call fits on a line gets a `callForm`, and `callForms.test.ts` validates each form against its own schema.
- `toolExecution.ts` went from 63% to 87% line coverage (`toolExecution.coverage.test.ts`).

**Evidence:** `/tmp/tool-gaps-ab/20261031-172534/report.md` (`/tmp` does not survive a reboot). Break-probe specs: `toolRepeats.json`, `coverToolExecution.json`.
