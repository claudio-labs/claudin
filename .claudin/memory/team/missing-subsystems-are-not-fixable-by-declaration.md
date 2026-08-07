---
name: the 107 TS2307 are the fork's shape, and declaring them away measured worse
description: 70 files this fork never received; generating .d.ts stubs traded 107 honest errors for 138 worse ones, so the only real fix is deleting the dead surface
type: project
---

`tsc` reports ~107 TS2307 ("cannot find module") against 70 relative paths that
do not exist in this fork: most of `src/server/`, and all of `src/daemon/`,
`src/proactive/`, `src/ssh/`, `src/login/`, `src/skillSearch/`,
`src/sessionTranscript/`, `src/agents-platform/`.

**None of it is reachable.** 103 of the import sites sit behind a `feature()`
that is off, 27 are type-only, and the rest are `await import()` inside
feature-gated commands. Verified on the worst case: `claudin server` imports six
missing modules, is gated on `DIRECT_CONNECT`, and its description string
appears zero times in `dist/cli.mjs`.

**Declaring them away does not work, measured 2026-08-07.** Generated `.d.ts`
declarations for all 70 (relative paths cannot use `declare module`, so it has
to be real files). TS2307 went 107 → 0 and the total went 2849 → 2880: the
missing modules had been stopping tsc from walking further into code that then
raises TS2339 on the invented shapes. 14 files improved by 17 errors, 16 got
worse by 48. Reverted.

Two things that cost time and are worth knowing:
- A syntax error in ONE generated `.d.ts` made tsc emit 22 parse errors and skip
  semantic analysis entirely, which reads as "2849 → 22, fixed!". Always check
  for TS1xxx before believing a large drop.
- The generator mis-parsed compiled component bodies as import statements
  (`export const const $ = _c(49)`), because compiled output has import-looking
  lines inside function bodies.

**The only real fix is deleting the dead command surface**, which is a product
decision about whether those features are ever coming back — not a cleanup.
