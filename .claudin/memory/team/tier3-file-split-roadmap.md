---
name: tier3-file-split-roadmap
description: How to split a giant file here — rank by size × churn × shape, cover first, move byte-identical and prove it by md5, the four traps (text-reading tests, bench fixtures, prose rules, ratchet paths), the feature() fold gate; the cheap splits are done (09-14..09-20), numbers in tier3-file-split-history
type: project
---

**Status (2026-09-20):** ROADMAP item 11's list is exhausted — measure the tree, don't work from it
(`git show cbf3325d:ROADMAP.md` has the original grades). Every high-churn relocatable file is a
barrel now; the live list is `code-design.md` §1. What each round moved and cost:
[[tier3-file-split-history]].

**What is left:**
- **Group B — high churn but monolithic** (`REPL.tsx`, `PromptInput.tsx`, `claude/streaming.ts`,
  `Config.tsx`, `AgentTool.tsx`, `query.ts`, `QueryEngine.ts`, `ManagePlugins.tsx`, each 74–91% one
  symbol): extract hooks/subcomponents into a composition root + siblings (`repl/controllers/`,
  `repl/hooks/`), never a barrel. `REPL.tsx` (3 exports) and `PromptInput.tsx` (1) must not become
  barrels — a barrel is for a wide surface, and `REPL.hooksOrder.test.ts` reads `REPL.tsx` as text.
- **Group C — big but frozen, don't start here:** `pluginLoader.ts`, `marketplaceManager.ts`,
  `normalize.ts`, `bridgeMain.ts`, `replBridge.ts`, `coreSchemas.ts` (codegen's `SCHEMA_FILE`),
  `native-ts/yoga-layout` (mirrors upstream). The Bash/PowerShell read-only-validation quartet is not
  duplication: a shared base over disjoint vocabularies.
- **Eight giants have zero characterization**, a risk without any split: `marketplaceManager.ts`
  (runs `gitClone`/`gitPull`, pinned only as TEXT) and `PowerShellTool/readOnlyValidation.ts` are
  next — both security surfaces.

**Ranking:** size × churn (`git log --follow`, mandatory since the 2026-08 reorg) × **shape**. Size
alone predicts nothing: on 2026-09-19 the four biggest files were all frozen. "Covered" means a
colocated `*.test.ts` that imports the module's FUNCTIONS — `claudemd.ts` and `compact.ts` were costed
as covered and were not. The Read outline reports only a signature's range when its parameter list
is long, so check the top symbol's body (`toolExecution.ts` read 11%, was 56%).

## The recipe, as executed four times

1. Grep the filename repo-wide (trap 1).
2. **Write the characterization suite FIRST, in its own earlier commit, against the pre-split file,
   and keep it byte-identical** across every extraction. One test pins the **exact export surface** —
   the only thing that catches an over-trimmed barrel re-export, which build and tsc both pass. For
   OAuth I/O, pin the surface, unit-test the pure parts, and say which is which. Pin
   `CLAUDIN_CONFIG_DIR` and cwd to temp dirs: ambient `~/.claudin` credentials made
   `isMaxSubscriber()` return true.
3. Move bodies and comments byte-identical; only import/export lines are new.
4. Module-level `let`/Map/cache goes in exactly ONE module; where two clusters share one, the owner
   exports a narrow accessor.
5. One commit per extraction, suite green at each.

Worked proof: during #129 an extraction over-trimmed a `checkPathConstraints` import — build and
typecheck passed, four characterization tests failed with `ReferenceError`.

**Before moving:** run the ownership check first — does each symbol live in the slice that owns the
behavior? `filesystem.ts` had 10 of 30 exports belonging elsewhere; moving them first halved the
barrel. Caller count is not the test (`toPosixPath` belongs in `shared/fs/path.ts`). Order those
moves by dependency. A split surfaces duplicates: delete one, never relocate it into a tidy sibling.

**While moving:**
- Move a constant DOWN into the sibling and re-export it from the root. Keeping it "up top" for one
  remaining reader makes the two files import each other, and build, typecheck and the suite all pass.
- Siblings import each other by sibling path, never through the barrel: suites that `mock.module` the
  barrel path would otherwise miss internal calls (`worktree`).
- A `feature()` require read by several groups lives once (`autoModeStateBridge`); repeating it
  folds N copies.
- Splitting a TEST: process-global state restored in a module-scope `afterAll` is wrong once split —
  the first shard to finish restores for all. Arm and restore through a harness function each shard
  calls (`useShimHarness()`, `useFileReadEnv()`), then run the shards in different orders.

## The gates

**md5 split gate.** For each side: strip a leading `export `, drop every line containing
`" from '"`, drop blanks, sort, `md5sum`. A residue of import-member lines (`  basename,`) and block
openers is expected — confirm each by eye; anything else is a real edit.

**feature() fold gate** (no test can be it — under `bun test` every flag reads `false`):

    rm -rf dist/chunks && bun run build
    grep -o 'pendingClassifierCheck:buildPendingClassifierCheck' dist/chunks/*.mjs | wc -l   # 8

`grep -c` is wrong (it counts files). `rm -rf` matters (3 generations are kept); `dist/cli.mjs` is not
the bundle; scope to `*.mjs`, since `.mjs.map` carries source text. A flag that is `true` KEEPS its
require, so assert the module's code is present, not the require string absent. After moving a `.txt`
require, grep the bundle for a template line (`You are a security classifier for an autonomous coding
agent`): a missing `.txt` is stubbed to `''` and auto mode silently auto-allows. The old "DCE
complexity cliff" was false — `preProcessSources` folds `feature()` by regex over source text.

**knip** counts a re-exported unused symbol at the barrel AND the sibling; refresh
`bun run deadcode:baseline` and check the diff is only the relocation.

## The four traps a split hits here

- **Tests read source files as TEXT** (`REPL.hooksOrder.test.ts` → `REPL.tsx`, `toolRedirect.test.ts`
  → `BashTool.tsx`, `bugfixes.test.ts` → `query.ts`/`AgentTool.tsx`; full 09-18 list in the history).
  They stay green scoped and break on the full run. An import written with `.ts` is invisible to a
  `.js` path codemod — grep both extensions.
- **Benches use giants as "large file" fixtures** and silently measure a 4%-size barrel. Repoint them
  in the same commit; `measure-outline-tokens.ts` needs a same-size-tier replacement.
- **`verify:rules --fix` heals directory counts, never prose.** The barrel list in `code-design.md`
  and the module map in `search-strategy.md` are hand-edited. It does NOT check a prose symbol
  attribution (`` `summarizeGrepOutput` in `src/…` ``) — only the `file.ts (symA, symB)` form — so
  those go stale silently while the path exists.
- **The typecheck ratchet fingerprints include the path**, so a split shows N new + N fixed; diff the
  path-normalized message multisets. Moot while the backlog is zero.

A break-probe pass also finds unguarded lines, not only untested ones; document them in the test
rather than writing an assertion that pretends to cover them ([[break-probe-harness]]).

See also [[coding-gotchas-go-in-rules-not-memory]], [[typecheck-backlog-shape]],
[[pr-129-lost-to-force-push]].
