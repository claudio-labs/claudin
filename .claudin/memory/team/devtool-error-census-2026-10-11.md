---
name: devtool-error-census-2026-10-11
description: Dev-tool error census 2026-10-05..11 (Git 527 calls/27 errors, WaitFor 125/4, RunTests 65/3, Typecheck 29/0, Build 17/0) — 6 harness bugs, 2 softer ones and the 4 follow-ups the reviews found, all fixed in PR 288 with 30+10+11 break-probes
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

**Follow-ups, fixed in the same PR:**
- A resume runs async, and the same flag picked its tools, so any tool outside
  the allowlist vanished. `resolveRunTools` (`AgentTool/toolFilter.ts`) takes the
  filter separately; `runAgent` records `toolFilter` in `AgentMetadata` (like
  `readOnly`), resume passes it back, and so does a run sent to the background
  mid-task (`AgentTool.tsx`), which had the same hole. A background run never
  holds Agent. Legacy metadata resumes on the async filter.
- Container registered background tasks through the caller's `setAppState`, a
  no-op in background agents; now `setAppStateForTasks` first, like Bash.
- WaitFor `isConcurrencySafe` follows the read-only verdict, like Bash.
- Coordinator mode lists `listWorkerTools(registry)`, not the raw allowlist.
- A degraded Typecheck run resolves its baseline as `ignore`, never captured.

Still open, by choice: the coordinator list ignores deny rules (workers are
built with them applied); runAgent/resumeAgent stay at ~4%/15% coverage —
their loop needs a live model, so the wiring is pinned on the source.

**Not code:** `git config --global rebase.autoStash true` would remove the pull
bucket outright; the dirty files were always the harness's own writes.

**How to apply:** re-run the census a week after the merge; expect the Git
"no such tool", WaitFor regex and pull buckets at 0. Specs:
`scripts/migrations/probes/devtoolErrorCensus.json`, `devtoolCensusPins.json`
and `devtoolCensusFollowups.json`.
Related: [[tool-error-census-2026-09-20]].
