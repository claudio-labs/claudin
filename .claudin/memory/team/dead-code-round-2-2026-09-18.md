---
name: dead-code-round-2-2026-09-18
description: Second dead-code round on branch chore/dead-code-round-2 — 8 commits, 202 files, −9324 lines; what shipped, the six flags that kept a ratchet entry and why, and the decisions left open
type: project
---

Branch `chore/dead-code-round-2`, cut from `main` at 2dedbdab on 2026-09-18.
**202 files, +204 / −9324.** Not merged at time of writing. Follows
[[dead-code-cleanup-2026-09-15]] (PR #204) and its ULTRAPLAN follow-up (#210).

The round started from a broken tree: `main` carried an uncommitted **staged
deletion** of `filePersistence.ts` while `turnLoop.ts:37` still imported
`executeFilePersistence`, so `bun run build` failed. Finishing that deletion was
commit 1 of 8.

## What shipped, by commit

| commit | what |
|---|---|
| c6463cfc | the FILE_PERSISTENCE slice; `getEnvironmentKind` moved to `teleport/environmentKind.ts` (type-only import, so the plans path picks up no axios) |
| a69a1a12 | 4 modules whose only importer was their own test (`thinkingTokenExtractor`, `tokenAnalytics`, `modelCache`, `clamp`) + the duplicate `TokenUsageTracker`/`extractThinkingTokens` inside the live `agent/context/tokens.ts` |
| 618c6a69 | `src/tools/ConfigTool/` — a complete tool absent from `tools.ts`, not even as a `null` placeholder |
| fee88d27 | 101 dead exports over 61 files, 25 barrel entries, and `FlashingChar.tsx` (orphaned by trimming the spinner barrel) |
| 39b3c08e | `src/providers/routing/smartModelRouting.ts` — `routeModel` + a 191-line test, no caller; **not** the R1 cost-routing item, which is `compactModel` + a fallback chain |
| 275c7558 | 20 folded-false flag clusters, incl. LODESTONE taking `platform/deepLink/` (6 modules, 1363 lines) |
| 8ae3d431 | DIRECT_CONNECT + EXPERIMENTAL_SKILL_SEARCH; missing-import baseline re-recorded 30 → 4 |
| 5f3a14f1 | the module map in `search-strategy.md` |

## The ratchet is the durable artifact

`scripts/build/feature-flags-source-guard.test.ts` went 38 off-map names → 15,
and its header now records **why each survivor survived**, so the next pass does
not re-litigate: SSH_REMOTE (the gate IS `registerSshCommand`'s body),
AUTO_THEME (gates the visible "Auto (match terminal)" picker row), TERMINAL_PANEL
(`app:toggleTerminal` stays bindable from the keybinding schema), and
REACTIVE_COMPACT + CONNECTOR_TEXT + HISTORY_SNIP (last sites inside committed
React-Compiler output, where the `$[n]` slots are load-bearing).

**The scanner had a hole worth more than the entries.** Its fast path was
`source.includes("feature('")` with a single-quote-only regex, so every file
using `feature("X")` was skipped **wholesale** — which is how
`ANTI_DISTILLATION_CC` stayed off the list while being folded false like
everything else. It now mirrors `build.ts`'s own both-quote regex, and that fix
is what surfaced five of the branches removed here. Related trap: a
`feature('X')` spelled out in a **comment** pins a removed flag on the list
forever, because the scanner reads raw source and cannot tell a call from a
mention — write the flag name in prose.

## Left open, each needing a human

- **The bash parser** — [[bash-parser-unreachable-behind-tree-sitter-flag]].
  ~4.5k lines that ship and cannot run. The biggest single item left.
- **`checkRepoForRemoteAccess`** — callerless, but the last `tengu_cobalt_lantern`
  site, so deleting it moves the flag-resolution characterization snapshot.
- **`directConnectManager.ts` + `useDirectConnect`** — survived as `REPL.tsx`'s
  `directConnectConfig` prop, which nothing passes now that
  `createDirectConnectSession` is gone. Ungated, so knip calls it reachable;
  unwinding it means editing REPL.tsx (3160 lines, compiler output).
- **`AttributionState` / `createEmptyAttributionState` / `incrementPromptCount`** —
  inert, but required fields on `AppState` / `ToolUseContext` / the
  lifecycle-hook types. A refactor of live interfaces, not dead-code removal.
  (`getAttributionTexts` lives in `vcs/git/attribution.ts` and IS live.)
- **`filterToBundledAndMcp`**, **`getAttachments`'s `skipSkillDiscovery`**,
  **`QueryEngineConfig.snipReplay`** — inert seams whose removal reaches into
  live paths.
- **`deadcode:prod`** (`knip --production`) is still not wired into
  `pr-checks.yml`, and `deadcode:ci` has "ci" in its name while no workflow runs
  it. That is why a module imported only by its own test is invisible to the gate.

## Method notes that paid off

Every phase ran the full gate before its commit: `build`, `build:strict`,
Typecheck (zero new), full `bun test`, `smoke`, `verify:privacy` over a
**cleared** `dist/chunks`, `verify:sdk-types`, `deadcode:ci`, `test:floor`
(24.04% floor, ended at 24.48%), plus a grep of the diff for a literal
`true`/`false` left where `feature()` belongs.

Two things the gates caught that review would not have: trimming a barrel entry
orphaned a file (`deadcode:ci`), and the missing-import baseline had 26 stale
entries after the deletions — `CLAUDIN_STRICT_IMPORTS=capture` shrank it 30 → 4
with **no new basename**, which is the shape that says nothing broke. Note the
capture needs `env VAR=… bun run build`; the inline `VAR=… cmd` form gets
refused by the permission classifier ([[feedback-compound-bash-denied-by-classifier]]).
