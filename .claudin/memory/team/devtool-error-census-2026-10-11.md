---
name: devtool-error-census-2026-10-11
description: Dev-tool error census 2026-10-05..11 (Git 527 calls/27 errors, WaitFor 125/4, RunTests 65/3, Typecheck 29/0, Build 17/0) — 6 harness bugs plus 2 softer ones, all fixed on branch fix/devtool-error-census with 31+10 break-probes; 4 follow-ups left open
type: project
---

Paired tool_use↔tool_result over every transcript since 2026-10-05, deduped
by tool_use id (`devtool-census.ts` + `followups.ts` in that session's
scratchpad, ~50 lines each — rebuild rather than hunt). Of 27 Git errors, 17
were the tool's to fix; Build and Typecheck each gave one false answer
without an error flag.

**Fixed (branch `fix/devtool-error-census`, one commit per item):**
1. Build: cargo `workRe` counts `Checking` too (`BuildTool/noOp.ts`); a
   `cargo check` was reported "up to date, nothing rebuilt". The opt-in live
   cargo suite had been dead since the reorg (fixtures wrote `src/platform/main.rs`).
2. Typecheck/Build/RunTests: `detectLauncherFailure` (`shared/diagnostics/`)
   sends a tool that never started (shell not-found, zsh, pyenv, mise/asdf
   shim without a version, bare exit 127) to the `runError` lane instead of
   "~N errors scraped". Anchored on the launcher's prefix, because that lane
   drops the raw tail. A clean-tree Typecheck no longer baselines that empty run.
3. Git: `git pull` refused for a dirty tree under a rebasing pull gets a
   diagnosis naming `git pull --autostash` (the biggest bucket, 7 + 1).
4. Git: a failed READ no longer stops a batch whose rest are reads, unless it
   is environmental (no repo, gh signed out/throttled/missing, timeout).
5. Git: `gh pr checks --watch` waits up to 90s for checks to register; "no
   checks" and a failed check (pr checks only) get diagnoses; an abort during
   the wait reports as an interruption.
6. WaitFor: a leading `(?s)`/`(?i)`/`(?m)` becomes RegExp flags (`u` left out:
   stricter in JS). `isReadOnly` uses Bash's verdict over `setup && command`.
7. `ASYNC_AGENT_ALLOWED_TOOLS` gains Git and WaitFor (background + resumed agents).

**Open follow-ups, found by the elegance review:** a resume passes
`isAsync: true`, which also picks the tool POOL, so any tool outside the async
allowlist (LSP, Monitor, ReportFindings…) still vanishes on resume — persist
the first run's async-ness in `AgentMetadata` like `readOnly`. WaitFor's
`isConcurrencySafe` is still unconditionally true. Coordinator mode lists the
allowlist, not the assembled pool, so a killswitched tool is still
advertised. Any degraded Typecheck run on a clean tree still records its
(empty) parse as the baseline.

**Not code:** `git config --global rebase.autoStash true` would remove the pull
bucket outright; the dirty files were always the harness's own writes.

**How to apply:** re-run the census a week after the merge; expect the Git
"no such tool", WaitFor regex and pull buckets at 0. Specs:
`scripts/migrations/probes/devtoolErrorCensus.json` and `devtoolCensusPins.json`.
Related: [[tool-error-census-2026-09-20]].
