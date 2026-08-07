---
name: typecheck-backlog-shape
description: tsc --noEmit never reaches zero here — ~2/3 is committed React-Compiler output; the fork was missing 22 type modules (restored 2026-08-06)
type: project
---

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

Shape of the backlog, measured 2026-08-06 on branch `chore/repo-improvements`
(4623 → 3161 errors over that branch):

- **~66% sits in committed React-Compiler output.** `src/components/*.tsx` files
  with `const $ = _c(N)` / `$[i]` bookkeeping are the real source; the transform
  strips parameter types, so 1529 of the 1710 implicit-`any` errors live there
  and cannot be hand-fixed — the pre-compiler sources are not in this fork. See
  `.claudin/rules/ink-tui.md` §6 before editing one.
- **~107 unresolved modules are deliberate**: source behind a disabled
  `feature()` flag that was never mirrored (`src/daemon/`, `src/server/`,
  `src/ssh/`, `src/proactive/`, `src/assistant/`, `src/tools/WorkflowTool/` —
  the last being upstream's `WORKFLOW_SCRIPTS` tool, NOT Claudin's own
  `src/tools/AgentWorkflow/`). `scripts/build.ts` stubs them at build time.
- The rest are genuine mismatches, newly visible now that the central types
  resolve.

**Why it was 4623.** The fork shipped without `src/types/message.ts` (39 types,
~240 imports) and with `src/entrypoints/sdk/coreTypes.generated.ts` +
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
