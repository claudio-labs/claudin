---
name: reorg-catch-all-dirs-retired
description: The 2026-08 reorg retired the seven catch-all dirs for feature slices; moduleBoundaries.test.ts guards them, and src/shared/ is NOT a clean leaf layer
type: project
---

Branch `refactor/screaming-arch`, 2026-08-14/15, 21 commits, ~3.5k files. The
seven catch-all directories are gone — `src/components`, `src/services`,
`src/utils`, `src/screens`, `src/constants`, `src/hooks`, `src/types` — replaced
by 18 feature slices: `agent/ providers/ tools/ commands/ mcp/ memory/
permissions/ sessions/ skills/ plugins/ vcs/ terminal/ platform/ shared/` plus
`native-ts/ vendor/ stubs/ __tests__/`.

`src/__tests__/moduleBoundaries.test.ts` is what keeps them gone. Nothing else
is structural: one `src/utils/foo.ts` added in a hurry re-opens the bucket and
the next twenty files follow it in, which is how they formed the first time.
The manifest of every move is `scripts/migrations/reorg/manifest.ts`.

**Two things the reorg did NOT establish, so don't cite them as invariants:**

- `src/shared/` is not a leaf layer. It has ~169 imports reaching *up* into
  feature slices (`platform/`, `providers/`, `tools/`). No test pins this,
  deliberately — pinning a layering rule the code doesn't follow would have been
  a fiction. If someone wants real layering, that is new work with a ratchet.
- The names that sound leaf-level collected the most. `constants/` held the
  entire system prompt (2.5k lines, now `src/agent/prompts/`) and `types/` held
  `Tool`'s own type surface. Treat "it's just constants" as a warning sign.

**Why:** the trigger was `/diff` needing to reach across eleven top-level
directories to do one feature's work.

Since 2026-08-15 the two patterns are named in `AGENTS.md` under
"Architecture — Screaming Architecture + Vertical Slice": the top level names the
domain, each slice owns its whole stack. Before that the rule existed only as
prose about "feature slices", which is why older notes never use either term.

**How to apply:** new file goes in the slice that owns it; genuinely
cross-cutting primitives go in `src/shared/`. If `moduleBoundaries.test.ts`
fails, move the file — do not add the directory to its list. The navigable map
is `.claudin/rules/search-strategy.md`. See
[[mechanical-rewrites-skip-producers]] for what the move broke silently.
