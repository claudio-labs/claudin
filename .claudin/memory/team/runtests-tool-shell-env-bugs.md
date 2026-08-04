---
name: RunTestsTool still carries the three shell/env bugs Typecheck fixed
description: Shipped RunTestsTool ignores the cwd it is handed, sets FORCE_COLOR=0 (which enables colour), and uses an env-prefix that only composes with a simple command — all unfixed as of 2026-08-04
type: project
---

`src/tools/RunTestsTool/run.ts` builds `CI=true FORCE_COLOR=0 ${plan.command}`
and hands it to `exec()`. Three defects, all of which `TypecheckTool` hit live
and fixed; RunTests was the model it was copied from and is **still unfixed**:

- It destructures `cwd` from its options but never `cd`s there — `cwd` is used
  only for the report-dir scan and the dossier. `exec()` has no cwd option, so a
  sub-agent under a worktree override runs the MAIN checkout's suite and files
  the results under the worktree path.
- `FORCE_COLOR=0` does not disable colour. Runners that test only for the
  variable's PRESENCE read it as a request to colourise and it overrides
  `NO_COLOR`; the in-file comment claims the opposite. Unset it instead.
- The `VAR=x VAR=y <command>` prefix form applies to a simple command only, so
  it silently fails to cover a compound or piped test command.

**Why:** found while auditing whether the Typecheck fixes had a sibling, after
the user asked whether the new tool was production-ready. Nothing was changed in
RunTests — it is a known, unaddressed defect, not a regression.

**How to apply:** flag these if RunTests behaviour is questioned, especially any
report of a sub-agent testing the wrong tree or a scrape defeated by ANSI. The
fixes to copy are in `TypecheckTool/run.ts` (`cd '<cwd>' && { … }` with
`preventCwdChanges: true`, unset FORCE_COLOR) — see
[[typecheck-tool-baseline-design]] and [[runtests-tool-language-coverage]].
