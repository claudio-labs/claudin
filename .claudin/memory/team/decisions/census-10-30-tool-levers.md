---
name: census-10-30-tool-levers
description: Since 2026-10-30 (#329) the plan approval names the seeded task ids and the direct TaskUpdate call (CLAUDIN_PLAN_TASK_IDS=0 reverts), and Bash's "only reads or searches files" note is off in advise mode (CLAUDIN_FILE_TOOLS_NOTE=1 restores); adopting leftover processes and reading short prose whole stay off — 4-arm A/Bs on Sonnet 5.5 and Opus 5.5
type: project
scope: src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts, src/tools/BashTool/redirectLanes.ts
impact: functional
---

**Decision (user, 2026-10-30, after both A/Bs, for every model):**
- **On by default:** the plan approval lists the seeded tasks as `#id subject`, and while
  TaskUpdate is deferred it spells out the direct call. `CLAUDIN_PLAN_TASK_IDS=0` goes back to
  the count alone.
- **Off by default:** Bash's file-reads note in advise mode ("This command only reads or
  searches files…"). `CLAUDIN_FILE_TOOLS_NOTE=1` brings it back. Refuse mode still refuses.
- **Still off, opt-in:** `CLAUDIN_ADOPT_LEFTOVERS` (what a command leaves in its process group
  becomes a task that TaskStop and the session's end stop) and `CLAUDIN_OUTLINE_PROSE_BY_LINES`
  (markdown and diffs under 250 lines and 25k chars are read whole).

**Why:** both runs used `scripts/bench/ab/tool-gaps-ab.ts`, 4 arms × 5, effort medium. All 40
sessions per model passed every hidden test.
- **Opus 5.5, Claudin's default:**
  - ToolSearch + TaskList followed the approval in 3/5 base sessions and 0/5 combo. The direct
    TaskUpdate call succeeded 5/5.
  - Combo mean $1.350 against base $1.412 and placebo $1.385; calls 43.4 against 47.6 and 48.8.
    The base–placebo spread is 2%, so the cost is near the noise and the calls are not.
- **Sonnet 5.5:**
  - The tasks gate failed: the model loaded TaskUpdate anyway in 3/5. The mechanism did not
    get worse.
  - Combo cost was +5.6%, which no single lever explains.
  - The user chose one default for every model.
- **The note:** taken 0 times in 17 firings across both models. Without it, the Read/Grep/Glob
  share held (Sonnet 50% vs 44%, Opus 100% vs 86%). The 10-25..30 census had it at 23% of 88.
- **Adoption:** the gate failed on both models; TaskStop ran in 1/5 and 2/5. On Opus,
  process-Bash calls halved (median 4 → 2), and no arm leaked a server. It also changes what a
  user sees: a server a command started dies with the session.
- **Prose:** no headroom on either model. The fixture's docs were outlined in at most 1/5 base
  sessions, because both models read them in ranges.

**Shipped unconditionally on the same branch:**
- TaskList lists tasks in id order.
- The read lane takes `~` and a loop over literal ranges into `sed`.
- A pivoted diff read through Bash names `| cat` and `-- <path>`, never the Git tool. The main
  arm gave 6 such hints on Sonnet and 3 on Opus; the branch gave 0.
- Stopping a command signals its whole process group.
- Commands run with job control off (`set +m`). The shell snapshot was replaying
  `set -o monitor`.
- `-p` does not wait for an adopted task (`holdsHeadlessExit`).

**Reopen it when:** a fixture shows the headroom the prose lever lacked (auto-outlined notes,
sub-agents asking for outlines), or a session needs a server stopped without the prompt saying
so. Run with `--only=base,placebo,combo`. The base arm pins the pre-10-30 defaults
(`LEVERS_OFF`).

**Evidence:**
- Reports: `/tmp/tool-gaps-ab/20261030-172617/report.md` (Sonnet) and
  `/tmp/tool-gaps-ab/20261030-182253/report.md` (Opus). `/tmp` does not survive a reboot.
- Two pre-registered gates count the wrong thing. The tasks gate counts a TaskStop load that
  takes TaskUpdate along. The diff gate counts the `| cat` the new wording asks for. The report
  prints a diagnostics section beside the gates.
- Probes: `scripts/migrations/probes/censusGaps.json`, 33, all red.
