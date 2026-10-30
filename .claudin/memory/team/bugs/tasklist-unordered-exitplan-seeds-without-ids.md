---
name: tasklist-unordered-exitplan-seeds-without-ids
description: TaskList printed tasks in readdir order (#13, #7, #8, #2…) — FIXED (sorted); ExitPlanMode names no task ids while TaskUpdate is deferred — the fix is CLAUDIN_PLAN_TASK_IDS, off after the Sonnet A/B; -p seeds tasks with TaskUpdate absent, open
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

**Status:** the order is FIXED on branch `fix/census-10-30-tool-gaps`: `listTasks` sorts with
`compareTaskIds`. Naming the ids is `CLAUDIN_PLAN_TASK_IDS`, off: on Sonnet 5.5 the model
loaded TaskUpdate anyway in 3/5 sessions ([[census-10-30-tool-levers-not-promoted]]). The
census found it ([[census-2026-10-30-cache-tools-context]]).

**Still open:** a tool_reference cannot load TaskUpdate from the approval, because text beside
one inside a tool_result is a server error. Seeding also ignores `isTodoV2Enabled`: in `-p`
without `CLAUDIN_ENABLE_TASKS=1`, an approval seeds tasks and points at a TaskUpdate that the
session does not have.
