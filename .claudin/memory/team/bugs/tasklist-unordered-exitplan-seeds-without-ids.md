---
name: tasklist-unordered-exitplan-seeds-without-ids
description: TaskList printed tasks in readdir order (#13, #7, #8, #2…) and ExitPlanMode named no task ids while TaskUpdate is deferred — both FIXED in #329 (sorted; ids + direct call by default); the "-p seeds tasks with TaskUpdate absent" item filed beside them was never a bug
type: project
paths:
  - "src/agent/tasks/tasks.ts"
  - "src/tools/TaskListTool/TaskListTool.ts"
  - "src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts"
---

**Symptom:**
- After a 26-step plan was approved (ferrous-dns 6e300fb6, 2026-10-28), TaskList returned
  `#13, #7, #8, #2, #23, #19…`.
- In 10-25..30, every approval was followed by `ToolSearch(select:TaskUpdate,TaskList)` and
  a `TaskList` before the first `TaskUpdate`. That is ~16 of 3,165 main requests over 8
  approvals.

**Where:**
- `listTasks` (`src/agent/tasks/tasks.ts`) returns the `readdir` order unsorted, and
  `TaskListTool.call` keeps it.
- `todoHint` in `ExitPlanModeV2Tool.ts` says the steps "have been seeded into the task list"
  and to use TaskUpdate, but names no ID, and both TaskUpdate and TaskList are deferred.

**Repro:** approve a plan whose Tasks section has 10+ steps, then call TaskList. The order
depends on the filesystem; it was scrambled on this machine.

**Status:** FIXED in #329. `listTasks` sorts with `compareTaskIds`. The approval names each
seeded task and the direct TaskUpdate call by default (`CLAUDIN_PLAN_TASK_IDS=0` reverts).
On Opus 5.5 that took the ToolSearch + TaskList pair after an approval from 3/5 sessions to
0/5 ([[census-10-30-tool-levers]]). The census found it
([[census-2026-10-30-cache-tools-context]]).

**Not a bug, though filed here on 10-30:** "in `-p` without `CLAUDIN_ENABLE_TASKS=1` an approval
seeds tasks and points at a TaskUpdate the session lacks". `seedTasksFromPlan` has returned early
on `!isTodoV2Enabled()` since 07-17, so nothing is seeded and the approval falls back to the
generic hint. The claim was written from the code's shape, not from a run. A test now pins the
guard (`ExitPlanModeV2Tool.call.test.ts`, "a session without Task tools").

**Still true:** a tool_reference cannot load TaskUpdate from the approval, because text beside
one inside a tool_result is a server error. Since `CLAUDIN_DEFERRED_CALL_FORMS` the listing says
which deferred tools can be called directly instead ([[census-10-30-compaction-meta-ttl]]).
