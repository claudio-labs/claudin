---
name: deadcode-gate-include-allowlist-hole
description: How the three dead-code gates came to be and what none of them can see — :ci/:prod/:exports all run in CI now, but knip only ever answers "is it imported", never "can it be reached"
type: project
---

> **Both holes below are CLOSED.** `deadcode:prod` got its `!` suffixes and its
> four test-infra `ignore` entries in round 3; `deadcode:exports`
> (`scripts/verify/deadcode-ci.ts`, a ratchet over `knip-baseline.json`) closed
> the exports dimension in round 4. All three run in `pr-checks.yml`. Kept for
> the mechanics, which still explain why a green run proves very little.
>
> **The limit that remains, and it is the important one:** knip answers "does
> anything IMPORT this", never "can any execution path REACH this". Round 5
> found 202 callerless symbols / 2,129 lines that every gate was green over —
> see [[dead-code-round-5-2026-09-19]] for the transitive fixpoint that finds
> them and the traps in writing one.

Measured 2026-09-18 while validating [[dead-code-round-2-2026-09-18]]. Corrects
two things that were believed about this repo's dead-code gate.

## 1. The gate has never checked a single export

`bun run deadcode:ci` is `knip --include files,dependencies,devDependencies`.
**`--include` is an allowlist**, and it omits `exports` and `types`. Turn them
on and the same config reports **943 unused exports + 406 unused exported
types**. None of that dimension has ever been visible to CI, which is a bigger
hole than the test-as-entry quirk below — and it is why 101 dead exports could
accumulate while the gate stayed green.

`.claudin/rules/testing.md` describes `deadcode:ci` as covering "unused FILES
and declared dependencies" — accurate, and the sentence is easy to read as
broader than it is.

Adding `exports,types` to the default-mode gate is viable only **with a recorded
baseline**, since the starting number is ~1349. Most of it is noise: knip's
"unused export" means only that nothing IMPORTS it, and the declaring module
usually uses its own export — see [[knip-unused-export-is-not-unused]] for the
three guards, one of which (a code generator reading a file as TEXT) rescued 32
entries including `HookJSONOutputSchema`.

## 2. `deadcode:prod` as specified is a no-op that cries wolf

The proposal was `knip --production --include files,exports`, to close the gap
where **knip counts a module imported by its own `*.test.ts` as USED** — which
is how five modules (`thinkingTokenExtractor`, `tokenAnalytics`, `modelCache`,
`clamp`, `smartModelRouting`) stayed invisible to the gate and had to be found
by hand.

Run against `knip.json` as written, it **analyzes zero files and reports all 57
dependencies unused.** Production mode uses only entry patterns carrying a `!`
suffix and *negates* project patterns that lack one
(`node_modules/knip/dist/WorkspaceWorker.js:136` and `:147`). `knip.json` has no
`!` anywhere. So wiring it into `pr-checks.yml` today would fail every PR with
57 phantom findings.

**What it takes to be useful**, measured: add the `!` production suffixes, keep
`--include files` only (`exports` is not viable at 1665 in this mode), and first
add `**/__testutils__/**`, `**/__fixtures__/**`, `**/__test-helpers__/**` and
`src/stubs/test-preload.ts` to `ignore` — otherwise 22 of its 24 findings are
legitimate test infrastructure. With that, it drops to **2** findings and
**would have caught all five** modules above, verified against `main`.

The two survivors it reports are both type-only and both correctly flagged:
`src/shared/types/hookEvents.ts` (14 lines, its own header names its single test
consumer — genuinely dead) and `src/shared/types/typeAssertions.ts` (27 lines,
`Equal`/`Expect` for the `*.types.test.ts` files, documented at
`.claudin/rules/testing.md:335` — **live test infrastructure, not dead**).

## Also worth knowing

Neither script runs in CI at all: `.github/workflows/pr-checks.yml` runs
`typecheck:ci`, `verify:sdk-types`, `verify:rules`, `smoke` and `bun test`.
`deadcode:ci` has "ci" in its name and no workflow executes it — it is only in
the [/pre-pr](../../skills/pre-pr/SKILL.md) skill.

And when counting occurrences to apply guard (a), **count raw occurrences rather
than stripping comments**: a comment-stripping pass produced a false "dead"
verdict for `getClaudeSkillScope`, which is live at
`src/permissions/filesystem.ts:1336`.
