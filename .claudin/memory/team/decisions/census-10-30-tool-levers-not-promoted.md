---
name: census-10-30-tool-levers-not-promoted
description: The three levers from the 10-30 census (plan task ids, short prose read whole, adopting leftover processes) and the file-tools note off were A/B'd on Sonnet 5.5 (4 arms × 5) and none became a default — cost +5.6% combo vs base, tasks and processes gates failed, outline had no headroom; the six bug fixes of the same branch shipped
type: project
scope: src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts
impact: rejected
---

**Decision (pre-registered gates, 2026-10-30):** none of the levers became a default. They are
in the code, off, and every prompt is byte-identical when they are unset:
- `CLAUDIN_PLAN_TASK_IDS`: the plan approval lists `#id subject` and a direct TaskUpdate call;
- `CLAUDIN_OUTLINE_PROSE_BY_LINES`: markdown and diffs under 250 lines and 25k chars are read
  whole instead of outlined;
- `CLAUDIN_ADOPT_LEFTOVERS`: what a command leaves in its process group becomes a task that
  TaskStop and the session's end stop.

The Bash file-tools note stays on.

**Why:** in `scripts/bench/ab/tool-gaps-ab.ts` on Sonnet 5.5 at medium effort, all 20
sessions per arm passed every hidden test (23/23).
- **Cost and calls:** the combo median was $0.682 against base $0.646 and placebo $0.637; calls
  37 against 36.
- **Tasks:** Sonnet ignored the direct-call line and loaded TaskUpdate anyway in 3/5 sessions.
  The TaskList the lever removes appeared in only 1/5 base sessions.
- **Outline:** no headroom. The docs were outlined in 1/5 base sessions, because Sonnet reads
  with offset/limit.
- **Processes:** the base leaked no server either, because the prompt asked to stop it.
  Process-Bash calls were a median of 2 in both arms, and TaskStop ran in 1/5. With the lever,
  the model killed the pid the note named, in one call.
- **The file-tools note:** turning it off kept the Read/Grep/Glob share (50% vs 44%). It was
  followed 0 times in 15 firings.

**What shipped instead (unconditional, same branch):**
- TaskList lists tasks in id order.
- The read lane takes `~` and a loop over literal ranges into `sed`.
- A pivoted diff read through Bash names `| cat` and `-- <path>`, not the Git tool. Main arm: 6
  wrong hints; branch arms: 0.
- Stopping a command signals its whole process group.
- Commands run without job control (`set +m`). The shell snapshot was replaying
  `set -o monitor`, which gave every `&` a group of its own.
- `-p` no longer waits for an adopted task (`holdsHeadlessExit`).

**Reopen it when:** an Opus 5.5 run shows the headroom Sonnet lacked. The census's ToolSearch
+ TaskList pattern after approvals and its outline re-reads came from Opus sessions. An arm is
`--only=base,placebo,combo --model=claude-opus-5-5`; ask before running it.

**Evidence:** `/tmp/tool-gaps-ab/20261030-172617/report.md` and its transcripts. Its gates
section prints the literal verdicts, with a diagnostics section beside them, because two
literal gates miscounted. The tasks gate counted a TaskStop load that took TaskUpdate along.
The diff gate counted the `| cat` the new wording asks for. The probes are in
`scripts/migrations/probes/censusGaps.json`; all 30 turn a test red.
