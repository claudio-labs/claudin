---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---
# Testing Strategy — Claudin Development Rules

Testing rules for Claudin's Bun-based test suite.

## Core Principles

- Tests are colocated: `src/path/to/module.test.ts` next to the file it tests
- Use Bun's built-in runner — no Jest, Vitest, or Mocha
- Real behavior over mocks: mock at the boundary (network, fs), never mock internal logic
- `test:coverage` runs at `--max-concurrency=1` — some tests touch shared global state

## Running Tests

Run tests through the **RunTests tool**, not Bash: it runs the same command and
returns a failures-first summary (per failure: name, `file:line`, source
excerpt) instead of raw runner output, so a failure lands with its location and
no follow-up Read. BashTool refuses a bare test command once and points there;
re-send the identical command when you genuinely need the raw output (print
debugging, a crash trace). The invocations below are the underlying commands —
pass one as RunTests' `command` when auto-detection picks the wrong suite.

Type-check through the **Typecheck tool**, for the same reason and with a bigger
payoff here: it reports only the diagnostics missing from the project's recorded
baseline, which in this repo is the difference between a handful of lines and
several thousand. `bun run typecheck` in Bash is refused once and points there;
re-send it when you genuinely need raw compiler output.

```bash
bun test                                   # full suite (~198 files)
bun test src/path/to/file.test.ts          # single file
bun run test:coverage                      # lcov + heatmap at coverage/index.html
bun run test:provider                      # focused: api/* + utils/context

# Always run before any PR touching api/* or provider logic:
bun run test:provider

# Always run before any PR touching build system, telemetry, or network:
bun run verify:privacy
```

## Test File Structure

```typescript
import { describe, expect, test, beforeEach } from 'bun:test'

describe('MyModule', () => {
  // Arrange — shared setup
  let subject: MyClass

  beforeEach(() => {
    subject = new MyClass({ /* minimal config */ })
  })

  test('does the thing', () => {
    // Arrange
    const input = 'test input'
    // Act
    const result = subject.process(input)
    // Assert
    expect(result).toBe('expected output')
  })

  test('falls back on invalid input', () => {
    // Fallback pattern — never throw, return best-effort
    const result = subject.process('')
    expect(result).not.toBeNull()
  })
})
```

## Snapshot Testing

Use Bun's built-in `toMatchSnapshot()` for output format validation:

```typescript
test('formats provider list', () => {
  const output = formatProviderList(mockProviders)
  expect(output).toMatchSnapshot()
})
```

After changing output format:
```bash
bun test --update-snapshots src/path/to/file.test.ts
# Review diffs in .snap files before committing
```

## Provider Tests — Special Rules

Any change to `src/services/api/*` or `src/utils/context*` must run `test:provider`:

```typescript
// src/services/api/myFeature.test.ts
import { describe, expect, test } from 'bun:test'
import { tryGetActiveProvider } from './activeProvider.js'

test('resolves provider from config', () => {
  // Use real config resolution, not mocked provider
  const provider = tryGetActiveProvider()
  expect(provider).toBeDefined()
})
```

**Never mock `tryGetActiveProvider()` in provider tests** — that defeats the purpose. Mock the config source instead.

## Build-System Invariant Tests

These tests in `scripts/` enforce build correctness — always run when touching `scripts/build.ts`:

```bash
bun test scripts/feature-flags-source-guard.test.ts   # feature() flag consistency
bun test scripts/measure-tool-schemas.test.ts          # tool schema size
bun test scripts/no-telemetry-growthbook-stub.test.ts  # no phone-home
bun test scripts/pr-intent-scan.test.ts                # PR security scan
```

## Mocking — Boundary Only

```typescript
// ✅ Correct — mock at the network boundary
import { mock } from 'bun:test'

mock.module('src/services/api/client.js', () => ({
  createClient: () => ({ messages: { create: mock(() => Promise.resolve(mockResponse)) } })
}))

// ❌ Wrong — mocking internal logic hides real bugs
mock.module('src/utils/errors.js', () => ({
  isAbortError: () => false  // this hides real abort-handling bugs
}))
```

### Cross-file mock leaks (critical)

`mock.restore()` resets `mock()`/`spyOn` spies but does NOT revert `mock.module()`.
Worse, Bun pre-applies every `mock.module()` specifier override for the WHOLE
`bun test` run — a mock in file B's `beforeEach` is active while file A runs, even
when A executes first, regardless of `--max-concurrency=1`.

- **Don't** write a test asserting on the REAL exports of a module any sibling file
  `mock.module`s (`src/utils/config.js` is the known case — mocked by
  `startupUpdateCheck.test.ts`). Extract the logic under test into a module nobody
  mocks (e.g. `privacyLevel.ts`) and test that.
- **Canonical teardown when you must mock a module:** snapshot the reals BEFORE
  mocking as a plain-object copy — `const real = { ...(await import('./x.js')) }`,
  never the live `import * as` namespace (it re-applies the stub) — then in
  `afterAll`/`afterEach` re-mock every module you mocked, both the relative form the
  file uses AND the `src/...` alias. Mocking a dep of a singleton (bootstrap/state)
  re-evaluates it → duplicate instances, so restore fully.
- Bisecting a leak: halve the file list with the victim run last; some leaks are
  2-file (a loader + a re-eval trigger).

### Ink/React components are unimportable under `bun test`

Any module whose import chain reaches `src/ink.js` fails to load under `bun test`
(or `bun -e`) with `Cannot find module '@growthbook/growthbook'` — that package is
a build-time stub from `scripts/no-telemetry-plugin.ts` that never applies outside
the bundler. So a `.tsx` component generally can't be imported by a colocated unit
test. Put pure logic (tree building, parsing, formatting, selection math) in a
separate module importing only libs + type-only + other pure modules, and re-export
it from the `.tsx` (e.g. `src/components/diff/fileTree.ts` split out of
`DiffFileList.tsx` for `fileTree.test.ts`).

> **`bun -e "import(...)"` is a FALSE NEGATIVE for importability** — it skips
> bunfig's `[test]` aliases (the growthbook stub), so it fails on modules `bun test`
> loads fine. Verify importability with an actual `bun test`, never `bun -e`.

## Coverage Targets

| Area | Target | Notes |
|------|--------|-------|
| `src/services/api/*` | 80%+ | Provider abstraction is critical |
| `src/tools/*` | 70%+ | Each tool needs at least happy + error path |
| `src/utils/*` | 75%+ | Shared utils used everywhere |
| Build scripts | 60%+ | Invariants via the guard tests |

### The test floor (`bun run test:floor`)

A ratchet, not a target. `test-floor.json` records the test-to-source LOC ratio
(18.87% as of 2026-08-07, over `src/` and `scripts/`) and the check fails when
it drops more than 0.5pp, or when one of the named invariant suites disappears:

```
src/services/compact/requestDeterminism.invariant.test.ts
src/services/compact/stableStubState.stub-byte-stability.test.ts
src/outputFilter/Bash/phase12Report.test.ts
scripts/feature-flags-source-guard.test.ts
scripts/measure-tool-schemas.test.ts
scripts/no-telemetry-growthbook-stub.test.ts
scripts/pr-intent-scan.test.ts
```

Do **not** chase the percentage. It cannot tell a real assertion from
`expect(true).toBe(true)`, and the seven suites above are worth more than any
number it could report — they pin request-byte determinism (the prompt cache
stops hitting the moment it breaks), per-filter reduction, and the build-system
invariants. What the ratio is good for is noticing a *loss*: a refactor that
deletes a suite along with the code it covered. Re-record deliberately with
`bun run test:floor:update`.

Both trees are walked because the first version was not: it measured `src/`
only, so deleting all four `scripts/` invariant suites left it green, reporting
"3/3 invariant suites present" while three of the four it should have been
counting no longer existed.

### Type-level tests (`*.types.test.ts`)

Compile-time assertions using `Expect<Equal<…>>` from
`src/types/typeAssertions.ts`. They are enforced by `tsc` — that is, by
`bun run typecheck:ci` — not by the runner, so a broken invariant shows up as a
new diagnostic on the `Expect<…>` line. Each file also carries a `test()` or
two pinning the runtime half of the same invariant.

They exist where a type is load-bearing and documented only in prose:
`src/types/utils.types.test.ts` (the three `DeepImmutable` carve-outs),
`src/entrypoints/sdk/sdkUtilityTypes.types.test.ts` (`NonNullableUsage`'s
deviation from the SDK shape) and `src/Tool.types.test.ts` (`BuiltTool<D>`
versus what `buildTool` actually spreads, including the fail-closed defaults).

Writing them is what surfaced two defects worth more than the assertions: the
`speed` intersection on `NonNullableUsage` was inert and justified by a false
claim about the SDK's `BetaUsage`, and `fingerprintDiagnostic` reported phantom
new errors whenever a file was added. Both are fixed. Watch for the tautology
trap in a new one — an assertion pinning "not null" against a field that was
never nullable passes with the whole mapping deleted, which is how three of the
first five in `sdkUtilityTypes.types.test.ts` shipped guarding nothing. Break
the production line and watch the assertion fail before believing it.

### Dead code (`bun run deadcode`, gated by `deadcode:ci`)

`knip`, configured in `knip.json`, in two forms:

- `bun run deadcode:ci` — the **gate**, in the Pre-PR checklist. Covers unused
  FILES and declared dependencies nothing imports. Both were cleared on
  2026-08-07 — three dependencies (`code-excerpt`, `stack-utils`, `tsx`) and
  nineteen files — so the gate starts from zero and any new finding is yours.
- `bun run deadcode` — the wider report, which additionally surfaces
  `unlisted`/`unresolved`.

One of the twenty "unused" files was not dead: `migrateFennecToOpus` was the
only one of eleven startup migrations never wired into `lifecycle.ts`. Treat a
knip file finding as a question, not a verdict — "nothing imports this" and
"this should not exist" are different claims.

`unlisted` and `unresolved` are deliberately outside the gate. This fork
resolves ~30 module names to stubs in `scripts/build.ts` and carries 138 imports
of files the fork never received, so in this repo "undeclared" is overwhelmingly
the intended state; gating on it would mean 30 hand-maintained ignores that
silently drift from build.ts. Two narrower blind spots ARE configured around:
knip does not read `bunfig.toml`, so the `[alias]` targets
(`src/stubs/growthbook-stub.ts`, `src/stubs/sandbox-runtime-stub.ts`) are listed
in `ignore` by hand, and the external CLI tools the code shells out to
(`rec`, `wslpath`, `secret-tool`, …) are in `ignoreBinaries`.

## What NOT to Test

- `dist/cli.mjs` — it's generated, test the source
- `MACRO.*` constants — they're inlined at build time
- Provider presets in `providerConfig.ts` — covered by smoke test
- Feature flags set to `false` — dead code paths

## Verifying attachments/system-reminders at runtime

**Do not grep the session `.jsonl` to check whether an attachment fired.** For
non-`ant` users `isLoggableMessage` (`src/utils/sessionStorage/pure/logging.ts`)
drops **every** attachment from the transcript except `hook_additional_context`
and `deferred_tools_delta`. A `todo_reminder_delta`, a memory delta, a plan-mode
attachment — none of them are written. Absence in the log is not evidence the
attachment was skipped, and reading it that way produces a confident false
negative (it did, while verifying the task reminder on 2026-07-26).

The observation channel that works is a temporary `appendFileSync` to `/tmp`,
at BOTH ends: the producer (`getTaskReminderAttachments` and friends in
`src/utils/attachments/lifecycle.ts`) to see the gate decisions and turn
counters, and the renderer (`normalizeAttachmentForAPI` in
`src/utils/messages/attachments.ts`) to capture the literal text the model
receives. Log the bail reason per branch, not just the success case — that is
what tells you *which* gate closed. `logEvent` is useless here: telemetry is
stubbed out at build time in this fork.

Drive it under tmux with `claudindev` (see the mouse-verification note for the
session recipe); a turn's worth of counters lands in the file in seconds.
Remember the instrumentation lives on top of committed code, so
`git checkout -- <files>` is the clean revert — and rebuild after, since the
launcher runs the bundle.

## Known full-suite flakes & the typecheck baseline

Full `bun test` on a clean `main` fails — but the failure SET depends on the
**directory**, not the commit (measured 2026-07-18, cross-checked main vs
branch in both environments):

- **Real project checkout**: 2 fails — `src/components/ProviderModelIndicator.test.ts >
  readSnapshot` ("renders the friendly model name…", "never leaks the [1m]
  context suffix…"). That file `mock.module`s global config/model modules, so
  under full-suite parallelism it races with other files' mocks; it passes in
  isolation and in any pairwise combination.
- **git worktree with symlinked `node_modules`** (e.g. `/tmp/...` review
  worktrees): 9 fails — the effort-cycling batch ("Opus 4.8 steps xhigh →
  max", "non-xhigh model… wraps", "numeric session effort…"),
  `deserializeMessagesWithInterruptDetection strips thinking blocks…`, and the
  `main.tsx — boot characterization (Fase 0)` --help snapshots.

So before blaming your change: run the same full suite on **main in the same
directory** and compare failure NAMES. Only a name not in main's set is a
regression signal. (Older list — `ProviderManager.test.tsx` Ollama/Vertex TTY
timeouts, `memory-turn-by-turn-bench` RSS flake — no longer reproduces on
2026-07 main; keep it in mind if they resurface.)

**Typecheck baseline:** `main` carries thousands of pre-existing `error TS`
(4617 on 2026-07-18, 4624 on 2026-08-03 — it drifts upward). Don't hand-compare
that count against a remembered number: call the **Typecheck** tool, which
records the backlog for a commit whenever it runs on a clean tree and afterwards
reports only what is new. The pass condition is **zero new**; the absolute total
is noise. A `⚠ … provenance unknown` result means no baseline exists for the
current commit — read the listed diagnostics rather than assuming they are
yours. `<new-diagnostics>` system-reminders can be STALE mid-edit snapshots —
confirm a cited diagnostic with the tool (`path:` filters the report) first.

## Pre-PR Checklist

- [ ] `bun run build` passes
- [ ] `bun run smoke` passes (version + help)
- [ ] Focused test passes (RunTests tool, scoped with `path`)
- [ ] `bun run test:floor` holds (7/7 invariant suites, ratio within 0.5pp)
- [ ] `bun run deadcode:ci` is clean (no declared dependency left unimported)
- [ ] If touching `src/services/api/*`: `bun run test:provider`
- [ ] If touching build/telemetry/network: `bun run verify:privacy`
- [ ] If touching output format: snapshots reviewed and updated
- [ ] Typecheck tool reports **zero new** diagnostics (the absolute count is
      irrelevant — the backlog is thousands deep)
