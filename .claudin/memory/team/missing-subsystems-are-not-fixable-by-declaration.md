---
name: the 107 TS2307 are the fork's shape, and only all-`any` declarations retire them
description: 70 files this fork never received; concrete .d.ts shapes measured worse and were reverted, but all-`any` declarations retired the TS2307 cleanly on 2026-08-13
type: project
---

`tsc` reports ~107 TS2307 ("cannot find module") against 70 relative paths that
do not exist in this fork: most of `src/server/`, and all of `src/daemon/`,
`src/proactive/`, `src/ssh/`, `src/login/`, `src/skillSearch/`,
`src/sessionTranscript/`, `src/agents-platform/`.

**CORRECTION, 2026-08-13: the old headline "declaring them away does not work"
was too broad**, and stood here for six days as a reason not to try. It works if
every export is `any`. The 2026-08-07 attempt emitted CONCRETE invented shapes,
so tsc resolved the import, walked into the caller, and raised TS2339 on
properties the invention did not have. `any` absorbs every property access and
so cannot raise TS2339 — that is the entire difference. 85 all-`any` declaration
files retired the ~107 TS2307 with no new errors.

Two consequences matter more than the win:

- **It buys no type safety at all.** An unresolved import is ALREADY `any` in
  TypeScript, so every call site was unchecked before and is unchecked now. This
  changes a diagnostic, not a check. Do not call it "fixing" the imports.
- **It was a small part of reaching zero.** `tsc --noEmit` hit 0 on 2026-08-13,
  but the declarations were ~107 of ~2820 errors; 493 modified source files did
  the rest. Do not credit the declarations for the zero.

**Reachability is NOT uniform**, though the generated boilerplate first claimed
it was ("every call site is behind a `feature()` flag that is off, so the stub is
never reached"). Measured across the 85: 9 call sites are type-only (erased at
emit), ~57 are `await import()` on gated paths, and **19 are eager value imports
in `src/commands.ts`** that genuinely do hit the `() => null` stub at runtime —
which is exactly why `/upgrade` and `/extra-usage` hang (see
[[upsell-commands-missing-login]]). A generator cannot assert "never reached at
runtime" per file; do not let it.

Watch the generator itself. It harvests names off adjacent import blocks and
invented six exports nobody imports (`ToolResultBlockParam`/`ToolUseBlock` in
`query/transitions.d.ts`, `LocalJSXCommandContext`/`ReactNode` in
`commands/login/login.d.ts`, `c` in `components/ui/option.d.ts`, and a literal
`js` fragment), plus three whole files for modules nothing imports. Verify call
sites before trusting a generated export list.

**A scan for importers MUST include `await import()` and `require()`**, not just
`import … from`. Counting only static imports made 60 of 88 files look
unreferenced when only 3 actually were — the fork reaches most of this surface
dynamically, which is the same reason it is gated.

Still true from 2026-08-07, and worth keeping:
- A syntax error in ONE generated `.d.ts` made tsc emit 22 parse errors and skip
  semantic analysis entirely, which reads as "2849 → 22, fixed!". Always check
  for TS1xxx before believing a large drop. The 2026-08-13 zero was checked the
  other way round — a scratch file with a deliberate TS2322 and a deliberate
  TS2339-on-an-invented-shape, both of which tsc caught, proving semantic
  analysis still ran.
- The generator mis-parsed compiled component bodies as import statements
  (`export const const $ = _c(49)`), because compiled output has import-looking
  lines inside function bodies.

**Deleting the dead command surface remains the only fix that removes the
surface** rather than the diagnostic — still a product decision about whether
those features are coming back, not a cleanup.
