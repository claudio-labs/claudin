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

**Decision:** four Plandex (`../plandex`, Go, cloud wound down 10/2025) ideas ported, on branch `feat/plandex-ports` (PR #341, opened 2026-11-08):
- **Elision guard.** Edit (code 11), Write (code 5) and Patch (that file only) refuse a comment-only line the old text lacks when it is a bare ellipsis (`// ...`, `# ...`), or opens or closes with one around a placeholder *phrase* (`existing code`, `rest of the file`, `… unchanged`, `same as before`, `other methods/functions/code`). A lone word next to an ellipsis (`other`, `previous`, `same`, `etc`) is prose, and doc-comment continuations (` *`, `///`) are skipped: the review found both refused ordinary comments. Prose files are skipped. Killswitch: `CLAUDIN_ELISION_GUARD=0`. Tool prompts are unchanged: the refusal message is the lever.
- **Rewind conflicts.** Each tool write sha256-fingerprints the file into `FileHistoryState.lastWrites`. This is in memory only, so after a resume nothing is flagged (pinned in `fileHistory.resume.test.ts`). A sub-agent's context forwards fingerprint updates, and only those, to the parent (`fileHistoryForwardWritesOnly`, `forkedAgent.ts`), so a delegated Edit is Claudin's write, not a conflict. Restoring code over a file that moved on since adds a step whose default keeps those files (`fileHistoryRewind(..., { keep })`); the gate and the keep set are the pure `needsConflictStep`/`keepFor` (`RewindConflictStep.tsx`). The preselected path waits for the conflicts before taking a choice, and a code-only restore that keeps every changed file says so. Headless and SDK rewind still overwrites. NotebookEdit writes are not fingerprinted (36% coverage, rare).
- **`/diff` hunk revert.** `x` works on the working-tree source only. The hunk is re-read from a fresh `git diff HEAD -- path`, because the parsed hunks drop `\ No newline` markers. It is then applied with `git apply -R --check` followed by `-R`. Staged changes are refused before the question (`hasStagedChanges`); new, deleted, renamed, binary and truncated files are refused too. Inside a git worktree `x` refuses (`worktreeShadowedRoots`): the view shows the main checkout ([[diff-reviewer-worktree-canonicalization]], still deferred), and a revert there would write into another checkout. `hunkAtRow` returns null for the whole file when the rendered rows and the segments disagree, the rule selection already followed.
- **Fallback.** The `fallbackModel` setting and `--fallback-model` (no longer print-only) both work, and a fallback outside `availableModels` is ignored, as a `model` setting outside it already was. Triggers: a 529 streak on any model once a fallback is set, spent retries on 5xx (`server_error`) or connection errors (`unreachable`), and a long or outlasting 429. `FallbackTriggeredError`'s reason is required. It holds for 10 minutes per primary→fallback pair and takes one hop; picking a model with `/model` clears every hold (`clearFallbackHolds`), and the warning says so. Sub-agents get none. The footer still shows the primary during a hold: accepted.

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

**Review round (2026-11-08).** Three read-only agents (bugs, quality and coverage, the feature as a whole) after the first gate was green. The bug agent proved five bugs with repro tests that the full suite and the live checks had missed: the worktree revert, the sub-agent conflict, the allowlist bypass, `hunkAtRow` failing open, and the elision false positives. They were committed red first (`test: reproduce the five bugs…`), then fixed one area per commit. The quality agent's blocker was the conflict gate pinned only by source text; it is now pure and tested by behavior. Live re-check: `/model` clears the hold, `x` refuses inside a worktree, and a single-hunk revert keeps its notice.
