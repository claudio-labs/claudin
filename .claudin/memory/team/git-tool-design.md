---
name: Git tool — D2, shipped 2026-08-04
description: Design record for the Git tool (batched git+gh commands, delegated permissions, delta lane) — what to cite, what did not survive measurement, and the traps found building it
type: project
---

**Scope:** this file owns the Git tool itself — the design decisions, the numbers
that are citable, and the traps found building it. Its place in the ranked
token-efficiency queue, and the 760-session sizing that picked it, are D2 of
[[dev-tooling-token-roadmap]].

`Git({commands: [...]})` — one tool over **all** of git and gh, reads and
mutations, landed on branch `feat/git-tool`. Each element is a verbatim shell command; shell
composition is refused and stays in Bash.

**Why:** the decisions below are not derivable from the code, and two of them
were reached by discarding an intuition that measurement killed.

**How to apply:** cite the numbers in the "what to cite" list and no others.
When touching the tool, read the four traps before changing behaviour.

## The design decisions that are not obvious from the code

- **Permissions delegate to `bashToolHasPermission`** with a synthesized
  `{command}` per element. That function is a ~900-line security pipeline
  (tree-sitter AST parse, `checkSemantics`, sandbox auto-allow, exact/prefix
  rules, classifier deny/ask, path constraints, the cd+git bare-repo guard,
  injection checks). Delegating means existing `Bash(git push:*)` rules apply
  with zero migration. **Never reimplement any of it in the tool.**
- The delegate returns `updatedInput: <its own synthesized Bash input>` and the
  harness applies that verbatim, so the tool echoes its OWN input on allow. This
  is the bug that made `apply_patch` dead on arrival in auto/bypass mode
  ([[checkbatchwrite-updatedinput-clobbers-input]]).
- **The permission dialog needed a dedicated component.** Unknown tools fall to
  `FallbackPermissionRequest`, whose "don't ask again" saves a TOOL-WIDE rule —
  one click would have granted `push --force`. `GitPermissionRequest` saves
  `Bash(<binary> <sub>:*)` instead.
- **Grammar allows quotes, refuses operators.** The shared redirect's
  composition regex counts `'`/`"` as composition, which is right for deciding
  what stays in Bash but would make `git commit -m "…"` inexpressible.
- **`isReadOnly` is per command and fails closed**, which is what lets
  `git diff` run inside plan mode while `git commit` does not. `git fetch` is a
  WRITE (it moves refs); `gh pr checkout` is a write despite the family;
  `git -C`/`git -c` are never read-only.

## What to cite (and what not to)

- Replay over the recorded corpus (`scripts/bench/tokens/git-summarizer-replay.ts`):
  **30.6% take** on addressable calls, 27.4% projected with trim tails stripped.
  `git diff` 37%, `gh run` 42%, `gh pr` 34%.
- Live A/B (1 run/arm, 15 turns, Sonnet 5, one build with
  `CLAUDIN_DISABLE_GIT_TOOL=1` as "before"): cost **−11.5%**, cache_creation
  **−24.6%**, cache_read −10.6%, input −7.4%.
- **Do NOT cite batching.** The list input was justified as collapsing bursts,
  but Bash already batches with `&&` at 1.50 git commands per call vs the tool's
  1.46, and calls-per-burst went UP (4.00 → 4.33) because the one-shot redirect
  refusal costs an extra call. The win is payload and cache.
- **Do NOT cite `git log`.** It got no summarizer: the Bash output filter's
  `--oneline` rewrite already took everything and the replay showed no headroom.
  A summarizer that fires for no gain is one more thing that can be wrong.

## Four traps found building it

1. **The bash provider pins PATH at the process's first `exec()`.** The snapshot
   it writes is `source`d by every later command, so `process.env.PATH` set
   afterwards never reaches the child — under `bun test` that first exec usually
   belongs to another file, making a PATH-based fake binary unreachable.
   `CLAUDIN_ENV_FILE` is the supported way in (sourced after the snapshot,
   `bashProvider.ts:157-169`).
2. **The Bash output filter rewrites commands the tool runs**: `git status` →
   `--porcelain --branch`, `git pull` → a one-line "already up to date",
   `gh pr list` → `--json …`. Any test asserting on tool output must pin the
   REWRITTEN form.
3. **Real git error text is not what you remember.** A stale push says
   `! [rejected] … (fetch first)` and never the words "non-fast-forward"; a
   pre-commit hook prints only the hook's own stderr with no git marker at all.
   Every pattern in `errors.ts` came from driving a fixture, not from memory.
4. **File-count pivots are useless for diffs** — 43 of 83 recorded unified diffs
   are single-file, so the pivot is on bytes (6 KB), not files.

## Delta lane (on by default)

Elides only per-file sections byte-identical to one already delivered, and only
when the previous body's `tool_use_id` is absent from `getClippedIds()` — never
elide text the model can no longer see. The stat table always lists **every**
file. `full: true` and `CLAUDIN_DISABLE_GIT_DELTA=1` escape it. This is the
working precedent for D3 (Read re-read dedup), which is 10× the surface.
