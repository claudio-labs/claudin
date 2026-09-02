---
name: isolation:worktree audit agents review COMMITTED HEAD, not uncommitted edits
description: Dispatching an isolation:"worktree" review agent against uncommitted working-tree changes makes it audit stale committed code; how to avoid phantom findings
type: feedback
---

An Agent launched with `isolation:"worktree"` gets a worktree whose base **lags behind the current branch tip** — it does NOT reliably reflect your latest commit, let alone uncommitted edits. The agent will silently audit a STALE version unless you force it onto the right commit.

**Why (two observations, same branch `feat/apply-patch-tool`, 2026-06-25):**
1. *Uncommitted edits invisible:* `patchFormat.ts` had uncommitted `ops`/`rebuildSegment` byte-preservation; a worktree agent on committed `d3df5a85` reported "rebuildSegment/ChunkOp does not exist; no byte preservation" — phantom, the code existed in the working tree.
2. *Committing first was NOT enough:* I then committed the hardening as `98ce0dc0` (branch tip) and launched 3 worktree agents. Their worktree bases came up at `c10da608` and `d3df5a85` (one/two commits BEHIND `98ce0dc0`), not the tip. The matcher agent dutifully audited `d3df5a85` and again declared `rebuildSegment`/`SEEK_PASSES`/the "Overlapping edits" guard "absent" — all present at `98ce0dc0`. Its whole "not-ready" verdict was invalid. Meanwhile a sibling agent that ran `git checkout 98ce0dc0` in its worktree first produced a fully valid review, and the IO-layer agent was valid only because its file (`applyPatch.ts`) happened to be unchanged between the two commits.

**How to apply:** Don't trust the worktree's default base. In the agent's prompt, make step 1 a mandatory `git checkout <exact-sha>` inside its worktree, followed by a **symbol-existence sanity gate** — `grep` for a function/string you KNOW is in the version under review (e.g. `rebuildSegment`, `Overlapping edits`); if it's missing, the agent is on the wrong commit and must STOP and report, not review. Always reconcile an agent's cited line numbers/symbols against the live file before acting on a finding — a mismatch means it audited a different version. (Committing first is still worth doing so the SHA exists in the shared object store for the checkout, but it does not by itself move the worktree base.)
