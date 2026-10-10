---
name: bash-read-lane
description: Since 2026-10-09 a Bash read the model directed comes back whole (CLAUDIN_BASH_READ_LANE=0 kills it), and one cut replaces the cap + summarizer on Bash (CLAUDIN_BASH_ONE_CUT=0); Sonnet 5.5 session A/B −28%, first edit at call 2; Opus neutral; own-writes refresh built but off
type: project
scope: bash/output-filter
impact: functional
paths:
  - "src/tools/shared/outputFilter/Bash/readLane.ts"
  - "src/tools/shared/outputFilter/Bash/index.ts"
  - "src/tools/shared/outputFilter/Bash/floor.ts"
  - "src/tools/BashTool/ownWrites.ts"
---

**Decision (user, 2026-10-09, branch `perf/bash-read-lane`):** two levers ON by default, one parked.
- **Read lane**: `isModelDirectedRead` (`readLane.ts`). A command made only of file prints (`cat`, `head`, `tail`), slices it bounds (`sed -n`, awk NR, `… | head -N`), non-recursive greps over named files, and glue comes back whole in `<bash-output-read>`, up to 28k chars.
  - The summarizer stands aside for that wrapper.
  - It replaced the parked pure-read pass-through and the bounded keep of #252. Both switches are gone: `CLAUDIN_BASH_READ_LANE=0` brings back every cut.
- **One cut**: the floor's cap becomes the only Bash cut.
  - Shape: 40 head + 60 tail + error windows (`cutShape.ts`) + path spare.
  - Diagnostics past 8k chars take it too.
  - `BashTool.skipsResultSummarizer` keeps the summarizer away from every result the filter ran on, below the 30k persist line.
  - `=0` brings back the 15+15 cap and the summarizer.
- **Own writes** (`CLAUDIN_BASH_OWN_WRITES=1`, OFF): after a Bash command, a read file it changed is brought up to date in `readFileState`, and the result names it. `refreshedFiles` lets `/resume` rebuild it.

**Why:** on Sonnet 5.5 both CLIs read with `cat`, and claudindev's cap, then the summarizer, cut it. The model then read every file again with Read. Those Reads also put six "modified by the user or by a linter" notes on the resume turn after its python edits. Session A/B `/tmp/session-cache-ab/20261009-225600`, N=5, simultaneous, all 30 sessions 18/18:

| median | claude | claudindev | placebo | lane | lane+cut | +own |
|---|---|---|---|---|---|---|
| cost | $0.382 | $0.441 | $0.476 | $0.316 | $0.302 | $0.326 |
| first edit at call | 2 | 5 | 5 | 2 | 2 | 2 |
| resume write | 886 | 6.7k | 10.8k | 701 | 744 | 794 |

- Lane vs claudindev: ranges separated.
- Confirmed on the final build with the defaults flipped (`-20261010-034534`, N=5, all 20 sessions 18/18):
  - new defaults: $0.314 [0.281–0.316], first edit at call 2, resume write 751;
  - `old` (both `=0`): $0.458 [0.391–0.508], first edit at call 6, resume write 6.8k;
  - claude: $0.381;
  - new defaults vs claude: −18%, SEPARATED.
- Opus 5.5 (`-230350`): every arm $0.995–$1.013, placebo $0.954, no read-gate refusals. Opus reads with Read and edits with Edit/Patch.
- read-files-ab (`/tmp/read-files-ab/20261009-232106`): the combo −1%, answers and edits 100%.

**What changes for a teammate:**
- A base bench arm now has the lane and the one cut. Pass `=0` to measure the old cutters.
- Own writes is parked because under the lane the model makes no Read for it to fix. It needs a bench where the model reads with Read and edits via Bash.
- `turnTaxonomy.ts` now counts a `<tool-result-summary>` Bash result as a cut (refetch-after-filter).

**Rejected:** the sizing rule pre-registered for the cut picked no candidate. No keep covers the median capped read while removing ≥70% of the cap's chars (plan `foamy-twirling-turtle.md`, "Sizing result"). The summarizer's shape was kept, and the A/B priced it.

**Evidence:** `readLane.test.ts`, `floor.test.ts` (10-09 corpus, one cut), `cutShape.test.ts`, `ownWrites.test.ts` (incl. `call()` in a child), `queryHelpers.extractReadFiles.test.ts`. Break-probe specs `readLane.json`, `oneCut.json`, `ownWrites.json`, `ownWritesCall.json`, `catAsRead.json`, all red. `read-credit-e2e.ts` scenarios 11-18 on the bundle.

**Superseded in part (2026-10-10):** the summarizer no longer cuts anything ([[summarizer-lossless]]), so `BashTool.skipsResultSummarizer` is gone and `CLAUDIN_BASH_ONE_CUT=0` brings back only the 15+15 cap. The one cut is the only cut Bash output gets; past the 30k line a result is paged.
