---
name: devtool-error-census-2026-10-11
description: Dev-tool error census 2026-10-05..11 (Git 527 calls/27 errors, WaitFor 125/4, RunTests 65/3, Typecheck 29/0, Build 17/0) — 6 harness bugs confirmed, 2 of them silent misreports in Build/Typecheck; none fixed yet
type: project
---

Paired tool_use↔tool_result over every transcript since 2026-10-05, deduped
by tool_use id (`devtool-census.ts` + `followups.ts` in that session's
scratchpad, ~50 lines each — rebuild rather than hunt).

**Harness bugs, each confirmed in code and reproduced or traced:**
1. Background and resumed agents have no Git: `ASYNC_AGENT_ALLOWED_TOOLS`
   (`src/tools/constants/tools.ts`) lists RunTests/Typecheck/Build but not Git,
   and `resumeAgent.ts` always runs `isAsync: true`. Two readOnly Code agents
   used Git, were resumed by SendMessage and got "No such tool available: Git".
2. WaitFor `until` is `new RegExp(until)` with no flags. The model writes
   `(?s)…` to match across lines; JS rejects that global inline flag (3 errors).
3. `gh pr checks --watch` right after a push exits 1 with "no checks reported"
   (2 cases, 2–4 extra calls each). Also, exit 1 for a failed check takes the
   error lane and stops the batch, while only exit 8 counts as a stall (`run.ts` `pendingChecksStall`).
4. Build: cargo `workRe` is `/^\s*Compiling\b/m` (`BuildTool/noOp.ts`), so a
   `cargo check`/`clippy` that printed `Checking …` reports "up to date,
   nothing rebuilt". Reproduced on a fresh crate. Silent, so no is_error.
5. Typecheck: a checker that never ran (exit 127, mise "No version is set
   for shim") is reported as "~N errors scraped" (`TypecheckTool/budget.ts`).
6. Git `UNSTAGED_BLOCKS_RE` (`errors.ts`) needs `cannot <word>:`, so "cannot pull
   with rebase:" gets no diagnosis. This is the biggest bucket (7 + 1). The user
   has `pull.rebase=true` and no `rebase.autoStash`, and the dirty files are
   always the harness's own writes (team memory, rule-map `search-strategy.md`).
   `git pull --autostash` recovers in one call.

**Softer:** `git rev-parse … @{u}` on an unpushed branch stopped a read batch 4×
(the PR protocol says "whether the branch tracks a remote"; `git status -sb`
never fails). **Normal:** conflicts, pathspec typos, >10 commands, `$` guard,
skip cascades, plan mode, classifier `stop_reason=refusal` on bench RunTests.

**How to apply:** fix 4 and 5 first, since they make false claims without
an error flag. Re-run the census after the fixes land and expect the Git
"no such tool", WaitFor regex and pull buckets at 0. Related:
[[tool-error-census-2026-09-20]].
