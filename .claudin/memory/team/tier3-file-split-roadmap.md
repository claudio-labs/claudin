---
name: tier3-file-split-roadmap
description: The Tier-3 giant-file split roadmap (item 11a-11m) lives only in a DELETED ROADMAP.md — recover it with git show; every actionable item is DONE as of 2026-08-14, and the new top offenders are listed here
type: project
---

The plan that drove every `src/<area>/` barrel-plus-siblings cluster in this repo
is **ROADMAP item 11**, and it is not in the working tree: `ROADMAP.md` was
deleted in `367058c2`, and an unrelated token-efficiency ROADMAP.md briefly
occupied the same path before that. Recover the real one with:

    git show cbf3325d:ROADMAP.md      # Tier 3 section, items 11a-11m

It is the only place the per-file suggestion, effort/risk grade and — critically —
the **deferred remainder** of each split are written down. Two of those deferrals
were worth more than the entries themselves:

- **11b** deferred "extração de `runHeadlessStreaming` em arquivo próprio com DI
  explícita (`HeadlessStreamingDeps`)".
- **11e** deferred "REPL.tsx mantém controllers (`onSubmit`/`onQuery*`) e
  composição. Controllers ficam para um trabalho futuro."

**Both were executed 2026-08-07** — `runHeadless.ts` 4197→604 across 9 siblings in
`src/platform/headless/print/`, `REPL.tsx` 4369→3145 across 5 hooks in
`src/agent/repl/controllers/`. No non-test source file is above 4k any more; the
largest remaining are `openaiShim.test.ts` (4618) and `bashFilter.test.ts` (3966),
both tests.

**CORRECTION 2026-08-14: 11i/11j/11k are DONE too** — an earlier version of this
memory listed them as open. All three are barrels now: `src/providers/shims/claude.ts`
66 lines over `claude/` (`1b543a4d`), `src/providers/shims/openaiShim.ts` 51 over
`openaiShim/` (`85c06f03`), `src/mcp/client.ts` 66 over `client/`
(`9db88d9c`). 11l (bridgeMain, feature-gated off) and 11m (ansiToPng, base64
assets) stay won't-do. **The ROADMAP-11 list is exhausted** — measure the tree, do
not work from it.

## New top offenders, measured 2026-08-14 (lines × 6-month commits)

Ranked by size × churn, since a big file only costs when people edit it:

1. ~~`src/tools/shared/codeOutline/scanSymbols.ts` — 3911 lines~~ — **DONE 2026-08-14**,
   3911 → a 191-line barrel over 18 modules (`types` `detectLang` `internal`,
   `mask/{core,languages}`, `clike/{types,detectors,specs,scan}`, `langs/*` with
   css+html+xml grouped as `webMarkup.ts` and yaml/toml/properties+env/dockerfile/
   makefile as `config.ts`). Largest module is now `mask/core.ts` at 600. Pure
   relocation; `scanSymbols.test.ts` (2855 lines, one `describe` per language) was
   **not touched** and stayed green — that untouched suite is what made a move this
   size safe, and is the pattern to repeat. Two things the plan's range table got
   wrong, both caught by a failing test: `BlockFrame` is shared by ruby AND lua (it
   went to `internal.ts`, not `langs/ruby.ts`), and `findDocLineCLike` +
   `RE_IDENT_START`/`RE_UPPER_START`/`RE_WORD_CHAR` needed wider export than
   "C-like engine only" implied. This is also where the tree-sitter work in
   [[symbol-parser-options-researched]] now lands — `langs/` is the seam for it.
2. `src/agent/repl/REPL.tsx` 3160 × **36** — highest churn in the repo even after 11e took
   it 4369→3145; the controllers came out, the composition did not.
3. `src/terminal/prompt-input/PromptInput.tsx` 2568 × **30**, one export, NOT
   React-Compiler output (so hand-splittable — check `grep -c '_c('` before assuming).
4. `src/tools/FileReadTool/FileReadTool.ts` 2440 × 24 and
   `src/providers/shims/claude/streaming.ts` 2479 × 21 — the two hot paths; streaming.ts is
   the 11j leftover (65% of the split `claude/` dir).
5. `src/providers/ui/ProviderManager.tsx` 3114 × 14.

**Big but nearly frozen — low payoff, do NOT start here:** `src/plugins/pluginLoader.ts`
3307, `src/platform/bash/ast.ts` 2679, `src/plugins/marketplaceManager.ts` 2648,
`src/agent/messages/normalize.ts` 2613, `src/platform/config/config.ts` 2268 (56 exports)
— all 1 commit in 6 months. `src/native-ts/yoga-layout/index.ts` 2578 is a port that
must mirror upstream, and `src/platform/bridge/bridgeMain.ts` 2975 is still 11l.

## Two traps a file split hits here that a normal refactor does not

- **Some tests read source files as TEXT.** `stableStubState.eviction-cache-break.test.ts`
  `readFileSync`s the production file and asserts on literal call strings, so
  moving the code makes it fail even though behavior is identical — and it is
  invisible to a test run scoped to the directory you edited. Grep the whole repo
  for the filename you are splitting before believing a scoped run is green.
- **The typecheck ratchet fingerprints include the file path**, so a split shows
  up as N new + N fixed. That is the documented refresh case, but prove it is a
  relocation before refreshing: capture `tsc` at HEAD (a worktree outside the
  repo, `node_modules` symlinked) and diff the **path-normalized message
  multisets**, not the counts. The 2026-08-07 split came back 2841→2837 with zero
  new error kinds; the handful that looked new were the same mismatch printed with
  a different union-member order or diagnostic code. (Those two figures are the
  split branch pre-merge — `main` reads 2820 the same day. See
  [[typecheck-backlog-shape]] before citing any absolute total.)

See also [[coding-gotchas-go-in-rules-not-memory]], [[typecheck-backlog-shape]].
