---
name: RunTestsTool carried the three shell/env bugs Typecheck fixed — FIXED 2026-09-24
description: RunTestsTool ignored the cwd it was handed, set FORCE_COLOR=0 (which enables colour), and used an env-prefix that only composes with a simple command — fixed on feat/dev-tools-deferred-advice with Build/Typecheck's wrapper
type: project
paths:
  - "src/tools/RunTestsTool/run.ts"
---

Until 2026-09-24 `src/tools/RunTestsTool/run.ts` built `CI=true FORCE_COLOR=0 ${plan.command}`
and handed it to `exec()`. Three defects, all of which `TypecheckTool` had hit
live and fixed:

- It never `cd`'d to the `cwd` it was given — `exec()` has no cwd option — so a
  sub-agent under a worktree override ran the MAIN checkout's suite and filed
  the results under the worktree path.
- `FORCE_COLOR=0` does not disable colour: runners that test only for the
  variable's PRESENCE read it as a request to colourise.
- The `VAR=x <command>` prefix form applies to a simple command only, so a
  compound or subshell test command died on a bash syntax error.

**Fix:** the same wrapper as `BuildTool/run.ts` and `TypecheckTool/run.ts` —
`cd '<cwd>' && {\nexport CI=true NO_COLOR=1\nunset FORCE_COLOR\n<cmd>\n}` with
`preventCwdChanges: true`. Pinned by `runTests — the shell wrapper` in
`RunTestsTool.test.ts`; each of the four lines goes red when reverted
(`scripts/migrations/probes/devToolsDeferredAdvice.json`).

**Two fixture traps the probes caught.** A bash syntax error quotes the command
line back, so a sentinel written literally in the command "survives" the very
failure the test is about — build it with `printf '%s'`. And the shell records
its cwd (`pwd -P >| file`, joined with `&&`) only after a command that exits 0,
so a `preventCwdChanges` test must use a succeeding command or it guards nothing.

Related: [[typecheck-tool-baseline-design]], [[runtests-tool-language-coverage]].
