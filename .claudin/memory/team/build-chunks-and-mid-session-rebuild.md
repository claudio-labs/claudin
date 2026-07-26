---
name: dist is code-split; rebuilding mid-session breaks the running session
description: Grep dist/ not dist/cli.mjs to confirm a string shipped, and expect skills/slash commands to die with "Cannot find module dist/chunks/…" after a rebuild inside a live claudin session
type: project
---

`bun run build` emits a code-split bundle: `dist/cli.mjs` is only the entry, and
almost all source lands in `dist/chunks/cli-<gen>-<hash>.mjs`. Two consequences
that both cost time on 2026-07-26 (PR #36):

**1. Verifying a build by grepping `dist/cli.mjs` is a false negative.**
`grep -c "my new string" dist/cli.mjs` returns 0 for code that shipped perfectly.
Use `grep -rl "my new string" dist/` instead. (`verify:privacy` reporting
"1398 bundle file(s)" is the tell that the bundle is not one file.)

**Why:** the entry only holds the fast paths (`--version`) and dynamic imports;
everything else is a chunk.

**How to apply:** when confirming a source change reached the bundle, grep the
whole `dist/` tree, or just run the built binary.

**2. A rebuild invalidates the chunks of any claudin process already running.**
The build's chunk GC prunes old generations ("pruned 914 file(s) from 1 old
generation"). A session started before the rebuild still holds paths into the
deleted generation, so the next lazy import fails — e.g. invoking a skill dies
with `Cannot find module '/…/dist/chunks/processSlashCommand-<oldgen>-….mjs'`.

**Why:** the launcher runs the bundle, and lazily-imported chunks are resolved
from disk at call time, not at boot.

**How to apply:** when developing Claudin *inside* Claudin, expect slash
commands and skills to break in the current session after `bun run build`. It is
not a code regression — restart `claudindev`, or run the checklist commands
directly instead of via the skill.
