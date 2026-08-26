---
name: outline-mask-desync-zero-symbols
description: THREE mask desyncs made scanSymbols return [] for whole files, silently turning Read(view='outline'), Read(symbol=), Grep symbols mode and Rename site selection into full-file dumps — fixed 2026-08-25, with the census and the two claims that did NOT survive
type: project
---

Found and fixed 2026-08-25. Audit base: the 33 sessions since 2026-08-18 (656
`Read` calls, 47 explicit `view:'outline'`, 26 auto-pivots) plus a census over
`src/**/*.{ts,tsx}` (3,236 files).

## What was broken

`scanCLike` fails open — an unbalanced masked copy returns `[]` — so ANY mask
desync costs the whole file, not one symbol. Three distinct causes, each
confirmed by breaking the fixed line and watching the test go red:

1. **Nested template literal inside `${…}`.** `scanCLike` called
   `spec.mask(source)` with no `interp`, so the outer template ended at the
   INNER backtick. `GitTool/run.ts` masked to 67 `{` against 66 `}`; with
   interpolation it is 69/69.
2. **A quote inside a regex inside `${…}`.** `maskInterpolationBody` had no
   regex handling, so the `'` in `${v.replace(/'/g, …)}` opened a literal that
   ran to the next apostrophe anywhere later. This is what hid
   `TypecheckTool/run.ts`, `BuildTool/run.ts` and `RunTestsTool.ts`, and it was
   only reachable AFTER fix 1 turned interpolation on.
3. **Apostrophe in JSX prose.** `<Text>…don't ask again…</Text>` — JSX text is
   scanned as code, so one unpaired `'` blanked every brace after it.

Fixes: thread `INTERPOLATION[lang]` into `scanCLike`; add `regexLiterals` to the
`Interpolation` spec and a shared `maskRegexLiteral`; add
`contractionApostrophes` to `CLikeMaskOptions` with a new `MASK_OPTS_TSJS`
(Go keeps LEGACY). Also added a `javascript` entry to `INTERPOLATION` — the
table only had `typescript`, and `EXT_TO_LANG` keeps `.js/.jsx/.mjs/.cjs` on
`'javascript'`, so every JS file was missing interpolation handling.

## Blast radius — it was never just the outline

The same empty table also broke `Read(symbol='X')` (`scanFile` returns null on
an empty table, so it dumped the whole file instead of one function),
`Grep(output_mode:'symbols')` (no enclosing symbol on any match), the
summarizer's `code-outline` strategy, `rulesLint`'s symbol-existence check —
and, worst, **`Rename` site SELECTION**: `findSites.ts` drops any occurrence
where `masked[at] !== source[at]`, so real rename sites inside a phantom string
were silently counted as `maskedOut` and left untouched.

## Census

220 of 3,236 files scanned to zero before; **198 after**. 22 files recovered,
**0 regressed to zero**, one file lost a single entry — a phantom `method` that
was a call argument, so a correction. Verified against a throwaway worktree at
HEAD, not from memory. The remaining 198 declare nothing at top level
(`describe`/`test` suites); teaching the TS detector about test blocks is a
separate, unstarted piece of work worth ~195 files / 22,916 lines.

## Two claims that did NOT survive

- **"`symbol=` adoption is zero" was wrong as a statement about the tool.** It
  is zero in the session corpus but **29% (28/96 reads)** in this repo's own
  `scripts/bench/ab/read-outline-pivot-ab.json`, deep arm, pivot ON. The
  populations differ, not the tool. That bench now prints a `read navigation`
  line so the number is visible without opening the JSON.
- **"The line trigger is the bad arm" was falsified.** Splitting the 26 pivots
  by trigger: char trigger (≥10k chars) n=20 with 9 `view:'full'` follow-ups
  (45%); line-only trigger n=4 with 1 (25%). The opposite of the prediction, and
  n is far too small to move `READ_AUTO_OUTLINE_THRESHOLD_LINES` or
  `MIN_SYMBOLS`. **The thresholds were deliberately left alone.**

Trap worth keeping: `renderOutline.ts` contains the pivot header string
verbatim, so a corpus scan that greps for "is large — showing a structural
outline" counts a plain Read of that file as a pivot. Same self-reference
inflation as [[session-corpus-census-inflation]].

See also [[auto-outline-pivot-false-cap-claim]] and
[[outline-blind-to-nested-members]] (the separate nested-member blind spot,
still open).
