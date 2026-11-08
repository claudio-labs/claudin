---
name: plandex-ports
description: Four ideas ported from Plandex on 2026-11-08 (elision guard, rewind conflicts, /diff hunk revert, wider model fallback with a 10-min hold) and the ones rejected (sandbox, builder race, tree-sitter validation, PTL→1M, shrink warning, cross-provider fallback)
type: project
scope: tools, rewind, vcs/diff, providers
impact: functional
paths:
  - "src/tools/shared/elisionGuard.ts"
  - "src/shared/fs/fileHistory.ts"
  - "src/vcs/diff/revertHunk.ts"
  - "src/providers/model/fallbackModel.ts"
  - "src/providers/model/fallbackHold.ts"
---

**Decision:** four Plandex (`../plandex`, Go, cloud wound down 10/2025) ideas ported, on branch `feat/plandex-ports`:
- **Elision guard.** Edit (code 11), Write (code 5) and Patch (that file only) refuse a comment-only line that is a bare ellipsis, or that opens or closes with one and names what it stands for (`// ... existing code ...`), when the old text lacks it. Prose files are skipped. Killswitch: `CLAUDIN_ELISION_GUARD=0`. Tool prompts are unchanged: the refusal message is the lever.
- **Rewind conflicts.** Each tool write sha256-fingerprints the file into `FileHistoryState.lastWrites`. This is in memory only, so after a resume nothing is flagged. Restoring code over a file that moved on since adds a step whose default keeps those files (`fileHistoryRewind(..., { keep })`). Headless and SDK rewind still overwrites. NotebookEdit writes are not fingerprinted (36% coverage, rare).
- **`/diff` hunk revert.** `x` works on the working-tree source only. The hunk is re-read from a fresh `git diff HEAD -- path`, because the parsed hunks drop `\ No newline` markers. It is then applied with `git apply -R --check` followed by `-R`. Staged, new, deleted, renamed, binary and truncated files are refused.
- **Fallback.** The `fallbackModel` setting and `--fallback-model` (no longer print-only) both work. Triggers: a 529 streak on any model once a fallback is set, spent retries on 5xx or connection errors, and a long or outlasting 429. It holds for 10 minutes per primary→fallback pair and takes one hop. Sub-agents get none.

**Rejected, and why:**
- The pending-changes sandbox: claudin edits in place by design.
- The builder race and strong-model escalation: these hide a second model's latency and cost calls.
- Tree-sitter validation: LSP diagnostics already cover it.
- PTL → 1M variant: Claude 5 is natively 1M (`context.ts:132`), and the preflight blocks first.
- The Write-shrink warning: appended nudges benched at zero adoption.
- Cross-provider fallback: the provider is process-global (`clientCache.ts`).
- Plandex dropped an LLM completion judge after disagreement cycles, so do not add one.

**Neighbors found, not fixed:**
- `query.ts:592-596` claims PTL is withheld, but it is not.
- OpenAI-compat `context_overflow` never becomes the PTL message.
- `agent:builtin` 529 exact match ([[builtin-subagents-skip-529-retry]]).
- `compareStatsAndContent` calls a same-size file with an older mtime unchanged.
- `maybeShortenFilePath` has no path-boundary check.

**Evidence:** probe specs `elisionGuard`, `rewindConflicts`, `diffHunkRevert`, `modelFallback`, `stagedWriteCommit`, `fileHistoryCover`, `withRetryCover` and `queryLoopCover` (all in `scripts/migrations/probes/`) are all red-on-break. Coverage before the changes: fileHistory 3.6→94%, withRetry 11→97% (from its new suites; `withRetry.test.ts` cache-busts its import, so a combined run reports 11%), query.ts 53→85%, stagedWrite 59→97%.
