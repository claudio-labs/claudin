---
name: leftover-adoption-tests-fail-on-local-main
description: Five process-leftover tests (CLAUDIN_ADOPT_LEFTOVERS in ShellCommand/runShellCommand, "with real processes" in leftovers.test.ts) fail on a CLEAN main checkout when bun test runs from a Claudin session's Bash (2026-11-01, e243a09d); three more suites flake only under full-suite load — not your branch's fault
type: project
paths:
  - "src/shared/proc/ShellCommand.test.ts"
  - "src/tools/BashTool/runShellCommand.test.ts"
  - "src/agent/tasks/LocalShellTask/leftovers.test.ts"
---

**Symptom:** a full `bun test` on a feature branch shows these red, with nothing in the branch
touching them:
- `ShellCommand — the process group > CLAUDIN_ADOPT_LEFTOVERS: a command that leaves a process
  running reports it with the result` (`result.leftovers?.pgid` ≠ the child pid)
- three `runShellCommand — CLAUDIN_ADOPT_LEFTOVERS > …` tests (`adopted?.status` undefined; the
  background one runs into its 10 s deadline)
- `leftovers.test.ts › with real processes > a shell that exits leaving a sleep behind: found, then killed`

**Where:** the leftover-process detection/adoption path these suites drive with real processes.

**Repro:** `git worktree add --detach <dir> main`, symlink `node_modules`, then
`bun test src/shared/proc/ShellCommand.test.ts src/tools/BashTool/runShellCommand.test.ts
src/agent/tasks/LocalShellTask/leftovers.test.ts` from the Bash tool of a running Claudin session:
the same 5 fail on e243a09d (2026-11-01). CI ("PR Checks", "Push on main") is green on that same
SHA, so the failure is specific to this local setup; not tried from a plain terminal.

**Load-only flakes in the same full run** (pass when run alone, all ~5 s timeouts):
`osc.test.ts` Windows clipboard fallback, `duckduckgo.test.ts` SafeSearchType.STRICT,
`launcherFailure.test.ts` "the same through zsh".

**Status:** open, cause not investigated (2026-11-01).

**Why not fixed:** found while verifying an unrelated feature (AskUserQuestion notes); out of scope.
Before blaming a branch, run these files on a clean main worktree first.
