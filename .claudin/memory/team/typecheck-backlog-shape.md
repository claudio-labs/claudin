---
name: typecheck-backlog-shape
description: how to read the tsc backlog and the baseline ratchet; TWO claims here were later disproven — "cannot be hand-fixed" (2026-08-07) and "never reaches zero" (2026-08-13)
type: project
---

**CORRECTION, 2026-08-13: the backlog reached ZERO.** `bunx tsc --noEmit` emits
no errors and `typecheck-baseline.json` is `count: 0`. Everything below about
*shape* is still the right way to read a backlog if one returns, but treat every
absolute number here as history. The ratchet still guards the diff, and the
baseline now ratchets against zero — so a newly added error fails CI outright
rather than hiding under a large number.

Where the 2820 went: ~2700 across 493 source files (mostly React-Compiler `t0`
annotations, per the correction below), plus ~107 TS2307 retired by all-`any`
declaration files — see [[missing-subsystems-are-not-fixable-by-declaration]],
whose own "declaring them away does not work" headline was corrected the same
day. Verify a large drop is real before believing it: the failure mode is tsc
skipping semantic analysis after a parse error in a generated `.d.ts`.

`bun run typecheck` is **not** a pass/fail gate — read it as a diff, never as an
absolute number. What CI runs is `bun run typecheck:ci`, a ratchet that fails a PR
only for fingerprints absent from the committed `typecheck-baseline.json`; refresh
it with `bun run typecheck:baseline`.

**The trap that broke it on the first clean-clone run:** tsc quotes ABSOLUTE paths
inside the *message* (`typeof import("/abs/src/...")`, and the second sentence of
every TS7016), and the fingerprint hashes the message verbatim — so 38 diagnostics
here hash differently under `/home/runner/work/...` than under a dev's home dir and
came back as phantom "new" errors. `scripts/typecheck-ci.ts` erases the checkout
path from raw output before parsing (same fix as `eraseCheckoutPath` in the tool's
`run.ts`). **Any new baseline-style check must be validated from a fresh clone at a
different path**, not just re-run in place — a fingerprint is a hash, so
machine-specific text in it is invisible on inspection.

**The absolute number moves constantly, and other memories quote stale snapshots
of it.** Read it live rather than citing one: `count` in the committed
`typecheck-baseline.json` (which also carries `capturedAt` and `capturedFrom`),
or `bunx tsc --noEmit | grep -c "error TS"`. On 2026-08-07 at `8b63601f` both
say **2820**. Every other figure in team memory — 4623, ~4320, 3161, 2849,
2841 — is a dated snapshot of the same shrinking number, not a contradiction;
treat any of them as evidence about its own date only.

Shape of the backlog, measured 2026-08-06 on branch `chore/repo-improvements`
(4623 → 3161 errors over that branch):

- **~66% sits in committed React-Compiler output.** `src/components/*.tsx` files
  with `const $ = _c(N)` / `$[i]` bookkeeping are the real source; the transform
  strips parameter types, so 1529 of the 1710 implicit-`any` errors live there.
  See `.claudin/rules/ink-tui.md` §6 before editing one.

  **CORRECTION, 2026-08-07: "and cannot be hand-fixed — the pre-compiler sources
  are not in this fork" was wrong**, and stood here for a day as a reason not to
  try. The compiler leaves the props type declared a few lines above the function
  it rewrote, so annotating the `t0` parameter fixes whole clusters at once.
  242 annotations took the branch 3161 → 2863. Read
  [[react-compiler-props-param-typing]] before believing any "structural,
  unfixable" framing about this half of the backlog — including this file's.
- **~107 unresolved modules are deliberate.** Superseded 2026-08-13: they ARE
  retired by declaring them, but only with all-`any` exports, and doing so buys
  no type safety — an unresolved import is already `any`. See
  [[missing-subsystems-are-not-fixable-by-declaration]] for the current list,
  which is wider than the obvious optional subsystems (`src/services` and
  `src/tools` account for 21 of the 70 missing modules).
- The rest are genuine mismatches, newly visible now that the central types
  resolve.

**Why it was 4623.** The fork shipped without `src/types/message.ts` (39 types,
~240 imports) and with `src/platform/entrypoints/sdk/coreTypes.generated.ts` +
`runtimeTypes.ts` as empty stubs, so `Message`, `Options`, `SDKMessage` and every
hook-input type were silently `any`. All 22 modules were reconstructed from their
use sites; every import of them is `import type`, so nothing changed at runtime.

**Two files that must stay in sync with the build:**
- `src/globals.d.ts` ← the `MACRO.*` keys in `scripts/build.ts`'s `define` map. A
  member declared here but absent there ships verbatim and throws
  `ReferenceError: MACRO is not defined` (that is exactly how
  `MACRO.FEEDBACK_CHANNEL` shipped broken until 2026-08-06).
- `src/stubbed-modules.d.ts` ← the stub tables in `scripts/build.ts`. Declare
  named exports, never shorthand `declare module 'x'`: shorthand makes every
  import a value, and type-position imports then fail with TS2709.

Do NOT point tsconfig `paths` at the shims in `src/stubs/` — tried and reverted;
it manufactures ~40 errors about fields those shims decline to describe, in
modules the telemetry/native-stub plugins replace before they ship.

SDK types regenerate with `bun run generate:sdk-types`; `verify:sdk-types`
(`--check`) fails on a stale `coreTypes.generated.ts`.

See also [[upsell-commands-missing-login]].
