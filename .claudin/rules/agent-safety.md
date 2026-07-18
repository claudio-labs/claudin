# Sub-agent & Worktree Safety — Claudin Development Rules

No `paths` frontmatter → this rule is **always in context**. It governs how to run
Agent/worktree sub-agents in THIS repo without corrupting the shared tree. Sub-agents
share the parent's real working tree and index — there is **no isolation** unless
you pass `isolation: "worktree"` (and even that leaks, see below).

## 1. Review/audit agents must never mutate git state

- Instruct review/audit agents to use ONLY read-only git (`git status`, `diff`,
  `show`, `log`). Forbid `git stash push/pop`, `reset`, `checkout -- `,
  `read-tree`, `add/rm`. A review agent that ran `git stash push/pop` for a
  typecheck baseline restored already-deleted files and left a wrong index staged;
  a concurrent reviewer then saw non-deterministic churn.
- **Sequence, don't overlap, when a mutator is involved.** Launch the read-only
  reviewers in parallel first, let them finish, THEN run the single build/test/
  break-and-restore agent in the MAIN tree. `bun run build` preprocesses ~253
  source files in place, so it cannot overlap with any agent reading source.

## 2. `isolation:"worktree"` has two traps

- **Stale base.** A worktree's base **lags HEAD** — it does NOT reflect your latest
  commit, let alone uncommitted edits. An agent will silently audit an old version
  and emit phantom "symbol absent / already-fixed" findings. Make step 1 of the
  agent's prompt a mandatory `git checkout <exact-sha>` inside its worktree,
  followed by a **symbol-existence gate**: `grep` for a function/string you KNOW is
  in the version under review; if missing, STOP and report, don't review. Always
  reconcile an agent's cited line numbers/symbols against the live file before
  acting.
- **Write leak.** Break-and-restore agents (Edit → run test → revert) can leak
  edits into the shared main checkout: the worktree is nested at
  `.claudin/worktrees/agent-<id>/` and `bun test`/some Bash canonicalize that path
  back to the main checkout, so an Edit "in the worktree" writes real `src/`, and
  the agent's in-worktree `git checkout --` does NOT revert main. After any such
  agent, do NOT trust its "main untouched" self-report — run `git diff HEAD` on the
  MAIN checkout yourself, `git checkout -- <files>` to the committed SHA, and delete
  leftover `__probe`/`__fuzz` scratch files. Prefer READ-ONLY agents on the main
  tree when possible.
- A worktree is cut from HEAD and does NOT carry uncommitted/untracked changes — if
  the work under review is uncommitted (the usual pre-commit case), a worktree agent
  sees none of it and will correctly bail.

## 3. Clean up only your OWN worktrees, by exact name

- Never broad-delete via `git branch -D` over a `git branch | grep worktree-agent`
  list — the worktree area is shared with other concurrent sessions (a bulk grep
  once deleted two unrelated sessions' refs). Each Agent result returns
  `worktreePath` + `worktreeBranch`; clean up exactly those:
  `git worktree remove --force <path>` then `git branch -D <exact-branch>`. For
  unregistered leftovers, `git worktree prune` is safe.

## 4. Empirical audit methodology ("agent review sem viés")

When the user asks for an unbiased review round (pt-BR: "lança um agent review sem
viés"), the audit agent's prompt MUST require: (1) for each new test, identify the
production line it guards, actually **break that line, run the test, confirm it
fails, then restore**; (2) be skeptical of commit messages and flag overclaims;
(3) leave `git status` clean, do not commit. This break-and-restore methodology is
what makes later passes find real bugs instead of rubber-stamping — earlier passes
missed tautological tests (`expect(true).toBe(true)`; a test re-implementing the
function it asserted on) that only a revert-and-watch pass caught. Don't claim
"verified clean" for anything the audit didn't actually exercise; acknowledge
defensive/no-op fixes as such rather than pretending they corrected a reachable bug.

## 5. Headless `-p` orphans auto-background sub-agents (bench caveat)

In `claudin -p`, an orchestrator that spawns auto-background sub-agents
(`autoBackgroundAgentsEnabled` default ON) drains them **non-deterministically** —
sometimes the parent exits before they finish, so their token usage is absent from
the parent's `usage` and the run looks artificially cheap. For any token/cost bench,
only trust runs where the drain sentinel appeared (`drained=Y` in
`scripts/profile/agent-bg-token-bench.ts`); for deterministic apples-to-apples vs
inline Claude Code, run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Always N≥3
reps, take the median — single runs are noisy.
