---
name: tier3-file-split-roadmap
description: The giant-file split programme — ROADMAP-11 exhausted, six barrels now live (BashTool ×2, config, state, insights); carries the feature() fold gate, the re-measured offender list, and the four traps a split hits here
type: project
---

The plan that drove every `src/<area>/` barrel-plus-siblings cluster in this
repo is **ROADMAP item 11**, and it is not in the working tree: `ROADMAP.md` was
deleted in `367058c2`. Recover it with `git show cbf3325d:ROADMAP.md` if you
ever need the original grades. **The ROADMAP-11 list is exhausted — measure the
tree, do not work from it.**

## What is a barrel today (2026-09-14)

| barrel | was | now | siblings |
|---|---|---|---|
| `src/tools/shared/codeOutline/scanSymbols.ts` | 3911 | 191 | 18 |
| `src/platform/headless/print/runHeadless.ts` | 4197 | 590 | 9 |
| `src/providers/shims/claude.ts` | — | 66 | `claude/` |
| `src/providers/shims/openaiShim.ts` | — | 51 | `openaiShim/` |
| `src/mcp/client.ts` | — | 66 | `client/` |
| `src/tools/BashTool/bashPermissions.ts` | 2528 | 68 | 7 |
| `src/tools/BashTool/bashSecurity.ts` | 2608 | 22 | 13 |
| `src/platform/config/config.ts` | 2276 | 101 | 7 |
| `src/platform/bootstrap/state.ts` | 1896 | 278 | 11 |
| `src/commands/insights.ts` | 2832 | 47 | 9 |

The bottom four landed on branch `refactor/split-giant-modules`, 2026-09-14.
**The BashTool pair is a RE-land, not a first one** — PR #129 merged in August
and its code was then dropped from `main` by a non-fast-forward push; see
[[pr-129-lost-to-force-push]] for the detection recipe and the
`refs/pull/N/head` recovery.

`src/agent/repl/` and `src/terminal/prompt-input/` are deliberately NOT on this
list — see "two files that must not become barrels" below.

## The live offender list, re-measured 2026-09-14

Ranked by size × churn, since a big file only costs when people edit it.

1. `src/agent/repl/REPL.tsx` 3304 × **50** — highest churn in the repo.
2. `src/terminal/prompt-input/PromptInput.tsx` 2661 × 38 — **no test of its own**.
3. `src/platform/settings/ui/Config.tsx` 2154 × 28 — React-Compiler output
   (`grep -c '_c('` before assuming hand-editable), and `configGroups.test.ts:167`
   reads it as source text.
4. `src/providers/ui/ProviderManager.tsx` 3101 × 17 — has a 1537-line test, which
   is the best safety net of any remaining candidate. **Best next target.**
5. `src/tools/BashTool/BashTool.tsx` 1443 × 24, `src/agent/compact/stableStubState.ts`
   1529 × 21, `src/tools/AgentTool/AgentTool.tsx` 1467 × 21.

**Big but nearly frozen — low payoff, do NOT start here:** `pluginLoader.ts`
3307 × 5, `bridgeMain.ts` 2974 × 6 (feature-gated off), `platform/bash/ast.ts`
2679 × 4, `marketplaceManager.ts` 2648 × 6, `agent/messages/normalize.ts`
2613 × 6, `native-ts/yoga-layout/index.ts` 2578 × 2 (a port that must mirror
upstream).

### Two files that must not become barrels

`REPL.tsx` exports 3 symbols and `PromptInput.tsx` exports 1. A barrel exists
for a WIDE surface (`claude.ts` re-exports ~20 names); what those two
directories already use is **composition root + siblings**
(`repl/controllers/`, `repl/hooks/`, the 23 flat files in `prompt-input/`), and
that is what to continue. On top of that, `src/agent/repl/REPL.hooksOrder.test.ts:29`
`readFileSync`s `REPL.tsx` and asserts the literal `"if (screen === 'transcript') {"`
— a barrel fails that on its first assertion.

### One file that is not a big file at all

`src/providers/shims/claude/streaming.ts` is 2560 lines of which `queryModel`
is **2093 (82%)**. There is no relocation available: only the four tail helpers
(~155 lines) come out cleanly, and `shouldDeferLspTool` is what
`lspDeferLatch.test.ts:53` reads as source text. Splitting it is a rewrite.

## The four traps a split hits here that a normal refactor does not

- **Some tests read source files as TEXT.** The full list as of 2026-09-14:
  `REPL.hooksOrder.test.ts` → `REPL.tsx`; `autoBackground.test.ts` →
  `config/defaults.ts`, `AgentTool.tsx`, `forkSubagent.ts`;
  `lspDeferLatch.test.ts` → `streaming.ts`; `configGroups.test.ts` →
  `Config.tsx`; `deferredToolsDelta.test.ts`; both `File{Edit,Write}Tool
  .diagnostics.test.ts`; `exploreAgentRemoved.test.ts` → `scripts/build/build.ts`.
  They stay green under a scoped run and break on the full one. Grep the
  filename repo-wide before believing a scoped run.
- **Benches use giants as "large file" fixtures, and a barrel makes them measure
  nothing — silently.** Six named `config.ts` and one named `bashSecurity.ts`;
  four named `state.ts`. No error, no empty result, just numbers for a file
  that is 4% of what the bench thinks it is. Repoint them in the same commit
  (`6c574def` is the worked example). `measure-outline-tokens.ts` samples by
  size TIER, so it needs a same-tier replacement, not a rename — two of its
  seven entries had already gone stale from the 2026-08 `runHeadless.ts` split.
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
