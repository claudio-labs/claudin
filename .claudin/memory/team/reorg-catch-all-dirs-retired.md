---
name: reorg-catch-all-dirs-retired
description: The 2026-08 reorg retired the seven catch-all dirs for feature slices; moduleBoundaries.test.ts guards them, and src/shared/ leaks upward under a ratchet since 2026-09-21
type: project
---

Branch `refactor/screaming-arch`, 2026-08-14/15, 21 commits, ~3.5k files. The
seven catch-all directories are gone — `src/components`, `src/services`,
`src/utils`, `src/screens`, `src/constants`, `src/hooks`, `src/types` — replaced
by 15 feature slices: `agent/ providers/ tools/ commands/ mcp/ containers/
memory/ permissions/ sessions/ skills/ plugins/ vcs/ terminal/ platform/
shared/` plus the three non-slices `native-ts/ stubs/ __tests__/`. That is 18
top-level directories, which is where the "18 slices" miscount came from;
`vendor/` was in the original list and no longer exists.

`src/__tests__/moduleBoundaries.test.ts` is what keeps them gone. Nothing else
is structural: one `src/utils/foo.ts` added in a hurry re-opens the bucket and
the next twenty files follow it in, which is how they formed the first time.
The manifest of every move is `scripts/migrations/reorg/manifest.ts`.

**Two things the reorg did NOT establish, so don't cite them as invariants:**

- `src/shared/` is not a leaf layer. **Superseded 2026-09-21:** the ratchet that
  paragraph asked for exists now. `moduleBoundaries.test.ts` counts the imports
  reaching *up* out of `src/shared/` into a slice and fails above **131** — a
  ceiling, not a target, so it only goes down. The four cheapest offenders moved
  out the same day (`constants/outputStyles.ts` → `agent/outputStyles/`,
  `fs/notebook.ts` → `tools/shared/`, `completionCache.ts` and `cleanup.ts` →
  `platform/`). Left deliberately, on importer count: `tokenEstimation.ts` (13
  upward, 44 importers, 19 of them relative from `scripts/bench/`) and
  `proc/Shell.ts` (12 upward, 41 importers, 4 benches naming its path as a
  string).
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
fails, move the file — do not add the directory to its list, and do not raise
the ratchet. The navigable map is `.claudin/rules/search-strategy.md`. See
[[mechanical-rewrites-skip-producers]] for what the move broke silently. The
sibling gate that resolves every `mock.module` specifier is
`src/__tests__/mockModuleTargets.test.ts`, written up in
`.claudin/rules/code-design.md` rather than here — it is a coding rule.
