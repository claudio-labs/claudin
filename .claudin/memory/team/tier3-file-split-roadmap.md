---
name: tier3-file-split-roadmap
description: The giant-file split programme — re-measured 2026-09-18 into groups A/B/C (relocatable+churning / monolithic / frozen); Groups A and the remaining giants are DONE (2026-09-19); carries the live barrels, the feature() fold gate, and the four traps a split hits here
type: project
---

The plan that drove every `src/<area>/` barrel-plus-siblings cluster in this
repo is **ROADMAP item 11**, and it is not in the working tree: `ROADMAP.md` was
deleted in `367058c2`. Recover it with `git show cbf3325d:ROADMAP.md` if you
ever need the original grades. **The ROADMAP-11 list is exhausted — measure the
tree, do not work from it.**

## What is a barrel today (2026-09-19)

| barrel | was | now | siblings |
|---|---|---|---|
| `src/tools/shared/codeOutline/scanSymbols.ts` | 3911 | 193 | 18 |
| `src/platform/headless/print/runHeadless.ts` | 4197 | 590 | 9 |
| `src/providers/shims/claude.ts` | — | 66 | `claude/` |
| `src/providers/shims/openaiShim.ts` | — | 51 | `openaiShim/` |
| `src/mcp/client.ts` | — | 66 | `client/` |
| `src/tools/BashTool/bashPermissions.ts` | 2528 | 68 | 7 |
| `src/tools/BashTool/bashSecurity.ts` | 2608 | 22 | 13 |
| `src/platform/config/config.ts` | 2276 | 101 | 7 |
| `src/platform/bootstrap/state.ts` | 1896 | 278 | 11 |
| `src/commands/insights.ts` | 2832 | 47 | 9 |
| `src/tools/PowerShellTool/pathValidation.ts` | 2055 | 19 | 6 |
| `src/mcp/auth.ts` | 1971 | 40 | 8 |
| `src/permissions/permissionSetup.ts` | 1454 | 60 | 10 |
| `src/vcs/git/worktree.ts` | 1544 | 54 | 8 |

The last four landed on branch `refactor/split-remaining-giants`, 2026-09-19;
the four above them on `refactor/split-giant-modules`, 2026-09-14.
**The BashTool pair is a RE-land, not a first one** — PR #129 merged in August
and its code was then dropped from `main` by a non-fast-forward push; see
[[pr-129-lost-to-force-push]] for the detection recipe and the
`refs/pull/N/head` recovery.

## Re-measurement 2026-09-18 — the cheap splits are DONE

Ranked the 45 largest non-test files by size × churn (`git log --follow`, which
is mandatory: the 2026-08 reorg makes plain `git log -- <path>` undercount) ×
**shape**. Shape is the axis that was missing before, and it reorders
everything: a file of many independent top-level symbols relocates
byte-identical, a file that is one 2k-line function does not.

The repo history is 2026-04-29 → now, so "all time" and "last 6 months" are the
same number.

### Group A — high churn AND relocatable (the only cheap targets left)

**DONE — branch `refactor/split-group-a`, 2026-09-19.** All four are barrels
now; see "What Group A actually cost" below. The table is the state that
justified the work.

| file | lines | commits | shape | net |
|---|---|---|---|---|
| `src/agent/compact/stableStubState.ts` | 1529 | 21 | 77 syms, largest 5% | 2153-line test |
| `src/permissions/yoloClassifier.ts` | 1688 | 18 | 65 syms, largest 18% | 3 tests |
| `src/permissions/filesystem.ts` | 1860 | 15 | 46 syms, largest 11% | via permissions |
| `src/permissions/permissions.ts` | 1450 | 18 | mixed, ~430 lines out | 295-line test |

## What Group A actually cost, and the four things it taught

Result: `stableStubState.ts` 1529 → **66**, `filesystem.ts` 1860 →
`filePermissions.ts` **23**, `yoloClassifier.ts` 1688 → **19**,
`permissions.ts` 1450 → **822** (re-exports plus the decision core, which
stayed on purpose — it is the security hot path).

**1. Run the ownership check BEFORE the split, not after.** Screaming
Architecture + Vertical Slice asks whether a symbol lives in the slice that
owns the behavior. Three of the four passed. `filesystem.ts` did not: 10 of its
30 exports, with 21 importers across six slices, were paths belonging to
memory/, skills/, agent/ and the host. Splitting first would have built a tidy
barrel around symbols that should not have been in the slice at all. They moved
to `memory/session/paths.ts`, `skills/bundledSkillsRoot.ts`,
`agent/scratchpad.ts`, `platform/tmpdir.ts` and `shared/fs/path.ts` first, and
the barrel that remained was less than half the size.

Caller count is NOT the ownership test. `toPosixPath`'s only importer was in
permissions/, and it still belongs in `shared/fs/path.ts` — "convert a path to
POSIX on this platform" has no domain owner.

**2. Order the ownership moves by dependency.** Moving the bundled-skills root
or the scratchpad before the temp dir would have left skills/ and agent/
importing permissions/ while permissions/ imported them back. Temp dir first,
then everything built on it.

**3. Verify a "byte-identical" move mechanically, not by reading.** For each
module: strip import/export lines from the pre-split file and from the
concatenated siblings, sort both, diff. A correct relocation shows an empty
diff. This caught the only two real deltas across ~5,500 relocated lines —
the `./` → `../` retarget of the classifier `.txt` requires, and one dropped
section-header comment — and it is far cheaper than reviewing the diff by eye.

**4. A barrel makes knip count an unused export twice.** A re-exported symbol
nothing imports is reported at the barrel AND at the sibling, so
`deadcode:exports` gains a finding for a pure relocation. Refresh with
`bun run deadcode:baseline` and check the diff is only the relocation.

### The bundle gate this rule got WRONG

An earlier draft of this memory said to prove the `TRANSCRIPT_CLASSIFIER` fold
with `grep -ro "require('src/permissions/classifierDecision" dist/chunks/ | wc -l`
and expect **0**. Both halves are wrong:

- The flag is `true` in `build.ts`, so the fold KEEPS the require and the
  bundler inlines the module. Absence would mean the fold went the wrong way.
  Assert the module's code is PRESENT — grep a symbol from it
  (`isAutoModeAllowlistedReadOnlyToolUse`), not the require string.
- `dist/chunks/` holds `.mjs.map` sourcemaps carrying the original source text,
  so an unfiltered grep matches the map and reports a phantom hit. Scope it
  with `--include=*.mjs` / `glob: "*.mjs"`.

The gate that IS right, and the one that matters after moving a `.txt` require:

    rm -rf dist/chunks && bun run build
    # then grep dist/chunks/*.mjs for a distinctive line of the template
    # 'You are a security classifier for an autonomous coding agent' → must be found

Nothing else can see that failure: a missing `.txt` is silently stubbed to `''`,
auto mode degrades to auto-allow with no error, and under `bun test` both
templates read `''` anyway because `feature()` is always false there.

### Two traps that only the full suite or a rename pass finds

- **An import with a `.ts` extension is invisible to a path codemod.**
  `claudinUiSurfaces.test.ts` imported `'src/permissions/filesystem.ts'`, not
  `.js`, and survived a `sed` over every `.js` specifier. Grep both extensions.
- **`verify:rules --fix` heals counts, never prose.** The barrel list in
  `code-design.md` and the module map in `search-strategy.md` are hand-edited.

### Group B — high churn but MONOLITHIC (a rewrite, not a relocation)

`REPL.tsx` 3082×**54** (`REPL` = 89%), `PromptInput.tsx` 2603×41 (91%, and it has
**no test of its own**), `claude/streaming.ts` 2279×39 (`queryModel` 80%),
`Config.tsx` 1929×29 (91%, React-Compiler output), `AgentTool.tsx` 1412×22
(84%), `query.ts` 1480×15 (`queryLoop` 85%), `QueryEngine.ts` 1384×12
(`submitMessage` 74%), `ManagePlugins.tsx` 2218×8 (82%, **no test at all**).
The path for these is hook/subcomponent extraction (`repl/controllers/`,
`repl/hooks/` already are that), never a barrel.

Two members of this class came out on `refactor/split-remaining-giants`
(2026-09-19), both as **composition root + siblings** — their export surface is
far too narrow for a barrel:

- `ProviderManager.tsx` 3156 → **1851**. The three OAuth setup screens went to
  `OAuthSetup.tsx`, four screens to `screens/`, and the pure helpers to
  `providerDrafts.ts` / `providerLookups.ts` / `providerManagerConstants.ts` /
  `ProviderManager.types.ts` — `.ts`, not `.tsx`, deliberately, so they stay
  importable under `bun test` instead of dragging in `src/terminal/ink.js`. The
  ~40 useState and every handler stayed on the root; the real cost was passing
  props, not moving lines. `renderMenu` **deliberately stayed**: it closes over
  16 members of the component's state, so extracting it would have bought a
  16-prop interface that is just the component turned inside out.
- `BashTool.tsx` 1366 → **507** (`bashCommandClassification.ts`,
  `bashSchemas.ts`, `applySedEdit.ts`, `runShellCommand.tsx`). The
  `buildTool({…})` object, `validateInput` included, stays in the root file
  because two suites read it as TEXT (trap 1 below).

### Group C — big but frozen; do NOT start here

`pluginLoader.ts` 3274×**6**, `marketplaceManager.ts` 2610×7,
`agent/messages/normalize.ts` 2455×8, `bridgeMain.ts` 2411×8,
`replBridge.ts` 2327×9 (`initBridgeCore` 66%), `coreSchemas.ts` 1901×14 (136
exports, purely mechanical — but it is `scripts/codegen/generate-sdk-types.ts`'s
`SCHEMA_FILE` source of truth), `providers/auth/auth.ts` 1775×11,
`native-ts/yoga-layout/index.ts` 2578 (a port that must mirror upstream —
do not touch).

The Bash/PowerShell read-only-validation quartet (~7.7k lines total) is **not
duplication**: `platform/shell/readOnlyCommandValidation.ts` is the shared base
that both `readOnlyValidation.ts` import, over disjoint vocabularies (POSIX
binaries vs cmdlets) and different tokenizers. Much of the bulk is data
literals (`COMMAND_ALLOWLIST` is 52% of one file), which split trivially but buy
little at 5 commits.

### The three biggest files in the repo were orphaned TESTS — DONE

Split on `refactor/split-remaining-giants`, 2026-09-19, together with
`FileReadTool.test.ts` (2177, and the highest churn of the four at 18 commits).
Best effort-to-risk ratio available, because splitting a test cannot break
runtime; in all four the production side was already split and the test never
followed.

- `providers/shims/openaiShim.test.ts` 4756 → **ten topic suites** under
  `shims/openaiShim/`, over `__testutils__/shimHarness.ts`.
- `outputFilter/Bash/bashFilter.test.ts` 4233 → **per-family suites** under
  `Bash/filters/`, plus `Bash/structural.test.ts` and appends to
  `registry`/`pipeline`/`compoundBody`.
- `codeOutline/scanSymbols.test.ts` 3322 → **15 siblings** under `codeOutline/`
  (`clike/`, `langs/`, `mask/`, `detectLang`, `renderOutline`).
- `FileReadTool/FileReadTool.test.ts` 2177 → **eight suites** over
  `__testutils__/fileReadHarness.ts`.

The one part of this that is NOT relocation is **process-global state**. Two of
the four set it at module scope and restored it in a module-scope `afterAll` —
correct in one file, wrong in eight, because the first shard to finish restores
on behalf of all the others (openaiShim's `mock.module` of `activeProvider`,
FileReadTool's `CLAUDIN_SIMPLE` + `CLAUDIN_DISABLE_TOOL_RESULT_CACHE`, which
un-disables the very cache that masks the dedup paths). Both now arm and restore
through a harness function each shard calls at its OWN top level
(`useShimHarness()`, `useFileReadEnv()`); for the shim's module mock the
override is installed once and the factory reads a module flag, so restoration
is order-independent and the module graph is not re-evaluated per test. The only
proof is empirical: run the shards in different orders, then alongside a file
that uses the real resolver.

### Four more production barrels — DONE, same branch

| file | was | barrel | siblings | what the split had to respect |
|---|---|---|---|---|
| `src/tools/PowerShellTool/pathValidation.ts` | 2055 | **19** | 6 | had **zero** tests — written from scratch first |
| `src/mcp/auth.ts` | 1971 | **40** | 8 | 1 of 8 groups covered; state is per-instance, no module mutable |
| `src/permissions/permissionSetup.ts` | 1454 | **60** | 10 | 1 of 9 groups covered; one gated require read by five groups |
| `src/vcs/git/worktree.ts` | 1544 | **54** | 8 | the only one with a module mutable AND two `mock.module` consumers |

Four decisions worth keeping:

- **`pathValidation` carried a private copy of `formatDirectoryList`**,
  duplicating `src/permissions/pathValidation.ts:38`. A split is the moment that
  surfaces: it was **deleted**, not moved. Relocating a duplicate into a tidy
  sibling makes it look intentional.
- **`permissionSetup`'s `feature('TRANSCRIPT_CLASSIFIER')` require is read by
  five groups.** It lives once, in `autoModeStateBridge`; no sibling repeats the
  `feature()` block, because repeating it would fold five copies. The fold gate
  at the bottom of this file is the only thing that can check that — under
  `bun test` every flag reads `false`.
- **`worktree`'s siblings import each other by SIBLING path, never through the
  barrel.** `resumeSession.test.ts` and `useReplExit.test.tsx` `mock.module` only
  `getCurrentWorktreeSession` on the barrel path, so routing an internal call
  back through the barrel would have made those mocks miss.
- **Coverage goes in a SEPARATE, EARLIER commit than the split**, written
  against the pre-split file and kept byte-identical across every extraction. A
  test born with the divided version proves the divided version is consistent
  with itself, not that behavior was preserved. Where the surface is OAuth I/O
  (`ClaudeAuthProvider`, `performMCPOAuthFlow`, `startupContext`) the honest
  answer is a **pin of the exported surface** plus unit tests for the separable
  pure parts — and saying which is which, rather than calling it all verified.

### Two files that must not become barrels

`REPL.tsx` exports 3 symbols and `PromptInput.tsx` exports 1. A barrel exists
for a WIDE surface (`claude.ts` re-exports ~20 names); what those two
directories already use is **composition root + siblings**
(`repl/controllers/`, `repl/hooks/`, the flat files in `prompt-input/`), and
that is what to continue. On top of that, `src/agent/repl/REPL.hooksOrder.test.ts:29`
`readFileSync`s `REPL.tsx` and asserts the literal `"if (screen === 'transcript') {"`
— a barrel fails that on its first assertion.

## The four traps a split hits here that a normal refactor does not

- **Some tests read source files as TEXT.** Re-scanned 2026-09-18:
  `REPL.hooksOrder.test.ts` → `REPL.tsx`; `configGroups.test.ts:167` →
  `Config.tsx`; `lspDeferLatch.test.ts:53` and `deferredToolsDelta.test.ts:284`
  → `streaming.ts`; `autoBackground.test.ts:65,83`, `prompts.test.ts:529` and
  `__tests__/bugfixes.test.ts:286` → `AgentTool.tsx`; `toolRedirect.test.ts` and
  `RunTestsTool/redirect.test.ts` (both `readFileSync` the BashTool root — line
  pins deliberately omitted, they rotted twice in one branch) → `BashTool.tsx`;
  `__tests__/bugfixes.test.ts:101,114,122,310` → `agent/query.ts`;
  `security-hardening.test.ts:72,82,91` → `marketplaceManager.ts`;
  `deferredToolsDelta.test.ts:291` → `compact.ts`;
  `toolRedirect.test.ts:18` needs `platform/bash/commands.ts` to exist on disk;
  `exploreAgentRemoved.test.ts` → `scripts/build/build.ts`.
  They stay green under a scoped run and break on the full one. Grep the
  filename repo-wide before believing a scoped run.
- **Benches use giants as "large file" fixtures, and a barrel makes them measure
  nothing — silently.** `cache-ab-bench.ts` names REPL.tsx, streaming.ts,
  query.ts, QueryEngine.ts, normalize.ts and stableStubState.ts;
  `outline-symbols-ab.ts` names REPL.tsx and PromptInput.tsx;
  `measure-outline-tokens.ts` names pluginLoader.ts, providers/auth/auth.ts and
  bridgeMain.ts; `repomap/05-ranking-variants.ts` and `read-strategy-ab.ts` name
  more. No error, no empty result, just numbers for a file that is 4% of what
  the bench thinks it is. Repoint them in the same commit (`6c574def` is the
  worked example). `measure-outline-tokens.ts` samples by size TIER, so it needs
  a same-tier replacement, not a rename.
- **`verify:rules` goes yellow and the prose goes wrong.** Directory counts heal
  with `bun run verify:rules --fix`, but the list of example barrels in
  `code-design.md` and the module-map lines in `search-strategy.md` are prose
  and do not. Update them in the branch (`b21c20b5`).
- **The typecheck ratchet fingerprints include the file path**, so a split shows
  as N new + N fixed. Prove it is a relocation (diff the *path-normalized
  message multisets*) before refreshing. Since the backlog reached zero this is
  usually moot — the Typecheck tool reports plain zero-new.

## The recipe, as executed four times

1. Grep the filename repo-wide (trap 1).
2. **Write the characterization suite FIRST and keep it byte-identical** across
   every extraction commit. Make one test pin the **exact export surface** —
   that is the only thing that catches an over-trimmed barrel re-export, and it
   is the failure the build and tsc both pass over. Break-and-restore every
   assertion that guards a shared mutable.
3. Move bodies and comments byte-identical; only import/export lines are new.
4. Module-level `let`/Map/cache goes in exactly ONE module. Where two clusters
   share one (`config`'s `lastReadFileStats` + `globalConfigWriteCount`,
   `state`'s three turn-token vars), the owner exports a narrow accessor — that
   is the only place new code is allowed.
5. One commit per extraction, suite green at each.

Worked proof that step 2 pays: during #129 an extraction over-trimmed a
`checkPathConstraints` import — `bun run build` passed, typecheck passed, four
characterization tests failed with `ReferenceError`.

## The `feature()` fold gate

If you need to prove a fold went the right way after moving `feature()` code:

    rm -rf dist/chunks && bun run build
    grep -o 'pendingClassifierCheck:buildPendingClassifierCheck' dist/chunks/*.mjs | wc -l   # 8

`grep -c` is WRONG here — it counts files-with-a-match and reports `1` on a
healthy build. The `rm -rf` matters (3 generations are kept), and `dist/cli.mjs`
is not the bundle. **No test can be this gate**: under `bun test` every flag
reads `false`.

The old "DCE complexity cliff" constraint that blocked the BashTool split for
months was **false and is disproven** — `preProcessSources`
(`scripts/build/build.ts`) folds `feature()` with a regex over the source text,
not Bun's evaluator, so file size and import count cannot affect the fold.

Two more things worth keeping from that split:

- **`bashCommandIsSafeAsync_DEPRECATED`'s body never executes under `bun test`.**
  `ParsedCommand.parse` returns no tree-sitter analysis in the runner, so it
  always takes the `if (!tsAnalysis)` fallback — deleting a validator from the
  async array changes no test outcome.
- **Prefer deleting a footgun over testing it.** A `replacesInputs?: boolean`
  that defaulted to the leaking behavior had no test at any of its three call
  sites; splitting it into `mergeReplacingLiveCache` removed the argument a
  caller could forget.

See also [[coding-gotchas-go-in-rules-not-memory]], [[typecheck-backlog-shape]],
[[pr-129-lost-to-force-push]].
