---
name: /diff reviewer has a living design doc (feature 8.1)
description: The /diff diff reviewer is actively iterated; its canonical spec lives in docs/features/8.1-diff-reviewer.md and is kept in sync as features land
type: project
---

The `/diff` diff reviewer (feature "8.1") is an actively-developed Ink/TUI feature whose
canonical spec is **`docs/features/8.1-diff-reviewer.md`** — a detailed living design doc updated
in lockstep as each feature lands.

As of 2026-06-18 it covers (recent additions this session):
- **Multi-repo / nested-repo discovery** for monorepos of independent repos: `findNestedGitRoots`
  in `src/vcs/git/git.ts` (bounded async scan — depth ≤3, ≤1500 dirs, skips node_modules/dot-dirs,
  fail-open), wired through `useWorkspaceDiff(roots, scanBases)`; `noRepo` now means "scan settled
  with zero groups", not "no explicit root".
- **Per-repo group headers**: colored Nerd-Font square swatch (`entityColorByIndex`, siblings
  never share a color) + name + bold change count + branch glyph (); children flatten at
  baseDepth 0 (no extra indent under the header). Glyphs degrade gracefully on non-Nerd terminals.
- **Log tab project selector** for monorepos: `[` / `]` cycle the repo whose `git log` is shown
  (`logRepoIndex` over `workspace.groups`); `useGitLog` reloads when its `cwd` changes.
- **Commit-node glyph**: Log graph swaps git's ASCII `*` for a green nerd dot (`commitIcon`).
- Shared `src/vcs/diff/ui/entityColor.ts` palette used for both commit authors and repo groups.

**Why:** the doc is the source of truth and several existing team memories already touch
diff/ internals (fileTree, ScrollBox clipping, gitdiff prefix parsing) — they cohere around this
one feature.

**How to apply:** before changing diff-reviewer behavior, read `docs/features/8.1-diff-reviewer.md`;
after changing it, update that doc to match — the established convention is to keep it current.
