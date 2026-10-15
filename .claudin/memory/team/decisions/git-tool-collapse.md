---
name: git-tool-collapse
description: Since 2026-10-15 a Git tool call collapses under fullscreen like a Bash command (one shell command per batch element, commits/pushes/PRs on the badge, a failed batch leaves the group); a bare commit is read from the filter's "✓ committed" line via FILTERED_COMMIT_MARK
type: project
scope: agent/tools (collapsed read/search group)
impact: functional
paths:
  - "src/agent/tools/collapseReadSearch.ts"
  - "src/agent/ui/messages/CollapsedReadSearchContent.tsx"
  - "src/tools/shared/gitOperationTracking.ts"
---

**Decision:** under fullscreen, a `Git` tool call joins the collapsed group's
shell lane, the one non-search/read Bash commands already used. Before, every
Git call broke the group and took its own row.
- It counts one "shell command" per element of the batch.
- Each outcome is scanned against its own command for commits, pushes,
  merges/rebases and `gh pr` actions, which lead the badge.
- A call that produced one is absorbed whole: `[add, commit]` reads
  "Committed 1a2b3c", like a Bash `git add && git commit`.
- A failed batch (`is_error`) leaves the group, so its row shows which command
  failed and which never ran. Bash keeps failures inside, unchanged.
- A running watch (`gh pr checks --watch`) puts its `git_progress` time on the
  header clock.
- Outside fullscreen nothing changed, for either tool.

**Why:** the user's call (2026-10-15), one option at a time; they took the
recommended option on all six.

**What changes for a teammate:**
- **A new tool joins the lane with one row in `SHELL_LANES`**
  (`collapseReadSearch.ts`). The row gives the commands, the hint, the
  `{command, output}` pairs of a result, and `breaksOutOnError`. Don't copy the
  lane: the table is the extension point, like `writeToolNames`/`applyWriteResult`.
- **The badge reads FILTERED text, not raw.** Both tools keep the output
  filter's result. The filter rewrites a bare commit's `[main 1a2b3c4] subject`
  to `✓ committed 1a2b3c4`, and until this change `parseGitCommitId` missed it.
  So a plain Bash `git commit` never reached the badge either; only chained
  ones did. The filter now builds that line from `FILTERED_COMMIT_MARK`
  (`gitOperationTracking.ts`), and a round-trip test fails if they drift.
- `trackGitOperations` (the session↔PR link) still reads raw text. It is a
  different consumer; don't merge the two.
- The public group fields stay `bashCount`/`gitOpBashCount`. They mean
  "shell commands" on the badge, Git included.

**Rejected:**
- **A parallel Git lane** (own flag, map and scanner). The first draft did it
  that way; the user asked "está elegante?" and it was replaced by the table.
- **Recording the op on the Git result** (an `outputSchema` field). It would
  not have fixed the Bash bare-commit miss, and it would have needed a schema
  change.

**Evidence:**
- Plan `.claudin/plans/enumerated-napping-mountain.md`, branch
  `feat/git-tool-collapse`.
- Break-probe `scripts/migrations/probes/gitToolCollapse.json`, 42 probes, all
  red. The real-repo pin in `GitTool/families.test.ts` goes red without the
  filtered-commit fix.
