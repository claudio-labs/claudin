---
name: tasklist-unordered-exitplan-seeds-without-ids
description: TaskList printed tasks in readdir order (#13, #7, #8, #2…) and ExitPlanMode named no task ids while TaskUpdate is deferred — both FIXED in #329 (sorted; ids + direct call by default); -p seeding tasks with TaskUpdate absent is still open
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

**Still open:** a tool_reference cannot load TaskUpdate from the approval, because text beside
one inside a tool_result is a server error. Seeding also ignores `isTodoV2Enabled`: in `-p`
without `CLAUDIN_ENABLE_TASKS=1`, an approval seeds tasks and points at a TaskUpdate that the
session does not have.
