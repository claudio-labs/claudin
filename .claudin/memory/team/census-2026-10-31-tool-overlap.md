---
name: census-2026-10-31-tool-overlap
description: Tool-overlap census 10-25..31 (claudin + ferrous-dns): Bash does a dedicated tool's job in 15–93% of uses depending on the job, but a switch is 1:1 in calls; only 24 of 739 classifier-bound Bash calls were read-only, so the "~250 avoidable classifier calls" estimate was wrong
type: project
expires: 2026-12-30
---

Window 2026-10-25 → 10-31: 81 transcripts, 6,859 tool uses and 4,626 tool-bearing API calls. The main thread made 1,104 classifier calls. The analysis session was left out. The scratch script was not committed; the counters that held up went into `feature-usage-census.ts` ([[tool-repeat-calls]]).

**Bash share of each job, counting the dedicated tool's uses plus Bash's:**

| job | Bash share | dedicated tool uses | Bash uses |
|---|---|---|---|
| Read | 15% | 1,744 | 311 |
| Grep | 29% | 1,162 | 470 |
| Glob | 64% | 64 | 116 |
| Git | 26% | 477 | 163 (30 of them from Explore, which has no Git) |
| RunTests | 77% | 39 | 128 |
| Build | 93% | 3 | 42 |
| Typecheck | 48% | 12 | 11 |
| TaskStop | 70% | 6 | 14 |
| Edit/Write | 10% | 739 | 79 |

**What the overlap does NOT buy:**
- **Calls.** Moving a job from Bash to its dedicated tool is one call for one call. Pushing the model toward the dedicated tools from the prompt was measured at zero adoption (0/17 in #329).
- **Classifier calls.** RunTests, Build, Typecheck and WaitFor gate exactly like Bash (`BuildTool.ts:262-270`). The skips seen for Build and Typecheck came from n=3 and n=12.
- **A read-only lane.** Replaying the 739 main Bash calls that reached the classifier through `checkReadOnlyConstraints` gave this split:
  - 24 read-only, sent there by the path/`cd` checks;
  - 47 with `awk`;
  - 141 with `$()`;
  - the remaining ~527 run or write something.

  A read-only lane is worth about 24–53 calls a week, not ~250.

**What did repeat, and what was done about it:**
- WaitFor re-polls after the 600 s cap.
- Empty Greps from slash globs.
- ToolSearch loads of the dev tools.

All three are fixed in [[tool-repeat-calls]].

**Tool switches:**
- 222 API calls used another tool of the same family on the same target in the next call. Most came after an "ok" result and are normal progress: search → read, Write → Edit.
- About 50 followed a failure, and 41 of those started at a Grep, mostly the slash-glob empties.

**How to apply:** use this as the baseline when a later census asks whether Bash still does a dedicated tool's job. Don't re-propose the read-only classifier lane from the overlap numbers alone.
