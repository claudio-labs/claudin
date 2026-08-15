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
debugging, a crash trace). Once RunTests has actually run a suite, the next Bash
call on that same suite is **not** refused at all — that escalation is the case
the refusal text itself blesses, so it costs no round-trip. The pass is spent on
use and re-armed by the next RunTests run, so a habitual `bun test` later in the
session is still redirected. The invocations below are the underlying commands —
pass one as RunTests' `command` when auto-detection picks the wrong suite.

Type-check through the **Typecheck tool**, for the same reason and with a bigger
payoff here: it reports only the diagnostics missing from the project's recorded
baseline. `bun run typecheck` in Bash is refused once and points there;
re-send it when you genuinely need raw compiler output.

```bash
bun test                                   # full suite (608 files, ~9000 tests)
bun test src/path/to/file.test.ts          # single file
bun run test:coverage                      # lcov + heatmap at coverage/index.html
bun run test:provider                      # focused: providers/ + agent/context

# Always run before any PR touching src/providers/ or provider logic:
bun run test:provider

# Always run before any PR touching build system, telemetry, or network:
bun run verify:privacy
```

### The suite is the only gate that reads a path inside a string

A module path is rewritten by a codemod — and checked by tsc, and by the build's
pre-scan — only where a parser can recognise it as one: `from '…'`, `import('…')`,
`require('…')`, `mock.module('…')`. Tests name modules from plenty of other
places, and every one of those is invisible to all three gates:

- a repo-relative string handed to Bun's `file()`, e.g. `file('utils/sandbox/…')`
- a plain string ARRAY of specifiers, imported later in a loop
- `join(import.meta.dir, '…')` to read a source file and assert on its text
- a directory path passed to the tool under test
- a template literal building a cache-busting dynamic import (`?t=${Date.now()}`),
  which an alias codemod skips on purpose — a computed specifier cannot be
  rewritten safely without reading it

Eight files in `src/` do one of these (found by PR #88, which moved 708 files).
Each stayed green under tsc and under `bun run build:strict` while naming a path
that no longer existed; the only thing that reports it is the assertion that
depends on it running.

> **`bun test` exiting 1 with `0 fail` is a real failure, not a glitch.** A module
> that cannot be loaded is reported as `# Unhandled error between tests`, with the
> file name on the line above it and outside the pass/fail counts — so the summary
> reads `8922 pass / 0 fail` and the suite still exits non-zero. Read the tail of
> the output, not only the counts.

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

Any change to `src/providers/*` or `src/agent/context/*` must run `test:provider` —
those are the two trees the script actually covers (see `package.json`):

```typescript
// src/providers/presets/myFeature.test.ts
import { describe, expect, test } from 'bun:test'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'

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

### A fake binary on PATH needs `CLAUDE_ENV_FILE`, not `process.env.PATH`

Setting `process.env.PATH` does NOT put a stand-in `gh`/`git` in front of the
real one for anything that goes through `exec()`. The bash provider writes an
environment snapshot on the process's FIRST `exec()` and every later command
runs `source <snapshot> && …`, re-exporting the PATH captured at that moment —
which under `bun test` usually belongs to a different test file. The lever that
works is `CLAUDE_ENV_FILE` pointing at a script that prepends the directory,
plus `invalidateSessionEnvCache()`; `installFakeGh` in
`src/tools/GitTool/__fixtures__/fakeGh.ts` is the worked example.

The failure mode is what makes this worth a rule: the test does not error, it
silently runs the REAL binary. A `gh pr checks 1 --watch` written for a fake
answered with this repository's actual PR #1 and the suite stayed green in
isolation (where the file did happen to create the shell first) while failing
in a full run.

## Mocking — Boundary Only

```typescript
// ✅ Correct — mock at the network boundary
import { mock } from 'bun:test'

mock.module('src/providers/transport/client.js', () => ({
  createClient: () => ({ messages: { create: mock(() => Promise.resolve(mockResponse)) } })
}))

// ❌ Wrong — mocking internal logic hides real bugs
mock.module('src/shared/errors.js', () => ({
  isAbortError: () => false  // this hides real abort-handling bugs
}))
```

### Cross-file mock leaks (critical)

`mock.restore()` resets `mock()`/`spyOn` spies but does NOT revert `mock.module()`.
Worse, Bun pre-applies every `mock.module()` specifier override for the WHOLE
`bun test` run — a mock in file B's `beforeEach` is active while file A runs, even
when A executes first, regardless of `--max-concurrency=1`.

- **Don't** write a test asserting on the REAL exports of a module any sibling file
  `mock.module`s (`src/platform/config/config.js` is the known case — mocked by
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
- **A mocked `logEvent` collects the whole process, not your unit.** Asserting
  `toEqual([...])` over everything the analytics mock captured passes only while
  no other module happens to log inside that window — and several log
  fire-and-forget from a promise the file that started them never awaited
  (`logMemoryDirCounts` in `src/memory/memdir/memdir.ts` is the one that has bitten:
  its `readdir` callback lands in whichever file is running when it resolves).
  Nothing about the victim file has to change for it to start failing; adding
  tests anywhere upstream is enough to move the timing. Select the events you
  are asserting on by name (`events.filter(e => e.name.startsWith('tengu_oauth'))`),
  which keeps "logged nothing" meaningful instead of merely lucky.

### A leaked stdlib mock, and the timer that outlives it

Both of these came out of one test file (`useReplExit.test.tsx`) and cost a day
during the `platform/` reorg. Neither announces itself as a mocking problem.

- **Leaking a stdlib module hits files that import nothing of yours.** That file
  mocked `child_process` with `spawnSync: () => ({ status: 0 })` and never
  re-installed the real one, so every later file got a `spawnSync` that returns
  instantly with no `stdout`. The victim was `bootSnapshot.test.ts`, which does
  `res.stdout + ''` — `String(undefined)` is `"undefined"`, which it then diffed
  against a 400-line help snapshot and reported as *the entire help text
  changed*. **When a subprocess-based test suddenly disagrees with a snapshot
  wholesale, check `status` first**: an exit 0 that produced no output in well
  under a millisecond did not run. Make the assertion say so rather than letting
  the diff misattribute it.
- **A timer armed under a stub fires after you restore the real thing.**
  `useReplExit`'s `handleExit()` arms a 10s failsafe that calls
  `process.kill(process.pid, 'SIGKILL')` and deliberately does not `unref` it;
  several of its branches return with the timer still running. The test stubbed
  `process.kill`, asserted, and handed the real one back in `afterAll` — so ten
  seconds later the bomb went off inside whatever file bun had reached by then
  and killed the run with **exit 137 and no output at all**. There is no failing
  test to point at, and the log simply stops.
- **Exit 137 from `bun test` is not automatically OOM.** Confirm before you go
  hunting for memory: sample `free -m` across the run and check
  `journalctl -k | grep -i oom`. Here peak use was 14 GB of 46 GB with no kernel
  OOM entry, which is what redirected the search to a self-inflicted SIGKILL.
  Bisect it by moving the suspected file out of the tree and re-running — a
  green suite minus one file localizes it in a single run.
- **How to apply:** when a test drives production code that arms timers, record
  them and clear them at teardown *before* restoring the global they would call
  — wrap `globalThis.setTimeout` in `beforeAll`, collect the handles, and
  `clearTimeout` each one in `afterAll`. Restoring a dangerous global while a
  caller of it is still scheduled is the bug.

### Ink/React components are unimportable under `bun test`

Any module whose import chain reaches `src/terminal/ink.js` fails to load under `bun test`
(or `bun -e`) with `Cannot find module '@growthbook/growthbook'` — that package is
a build-time stub from `scripts/no-telemetry-plugin.ts` that never applies outside
the bundler. So a `.tsx` component generally can't be imported by a colocated unit
test. Put pure logic (tree building, parsing, formatting, selection math) in a
separate module importing only libs + type-only + other pure modules, and re-export
it from the `.tsx` (e.g. `src/vcs/diff/ui/fileTree.ts` split out of
`DiffFileList.tsx` for `fileTree.test.ts`).

> **`bun -e "import(...)"` is a FALSE NEGATIVE for importability** — it skips
> bunfig's `[test]` aliases (the growthbook stub), so it fails on modules `bun test`
> loads fine. Verify importability with an actual `bun test`, never `bun -e`.

## Coverage Targets

| Area | Target | Notes |
|------|--------|-------|
| `src/providers/*` | 80%+ | Provider abstraction is critical |
| `src/tools/*` | 70%+ | Each tool needs at least happy + error path |
| `src/shared/*` | 75%+ | Cross-cutting primitives used everywhere |
| Build scripts | 60%+ | Invariants via the guard tests |

### The test floor (`bun run test:floor`)

A ratchet, not a target. `test-floor.json` records the test-to-source LOC ratio
(19.43% as of 2026-08-15, over `src/` and `scripts/`) and the check fails when
it drops more than 0.5pp, or when one of the named invariant suites disappears:

```
src/agent/compact/requestDeterminism.invariant.test.ts
src/agent/compact/stableStubState.stub-byte-stability.test.ts
src/tools/shared/outputFilter/Bash/phase12Report.test.ts
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
`src/shared/types/typeAssertions.ts`. They are enforced by `tsc` — that is, by
`bun run typecheck:ci` — not by the runner, so a broken invariant shows up as a
new diagnostic on the `Expect<…>` line. Each file also carries a `test()` or
two pinning the runtime half of the same invariant.

They exist where a type is load-bearing and documented only in prose:
`src/shared/types/utils.types.test.ts` (the three `DeepImmutable` carve-outs),
`src/platform/entrypoints/sdk/sdkUtilityTypes.types.test.ts` (`NonNullableUsage`'s
deviation from the SDK shape) and `src/tools/Tool.types.test.ts` (`BuiltTool<D>`
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
non-`ant` users `isLoggableMessage` (`src/sessions/pure/logging.ts`)
drops **every** attachment from the transcript except `hook_additional_context`
and `deferred_tools_delta`. A `todo_reminder_delta`, a memory delta, a plan-mode
attachment — none of them are written. Absence in the log is not evidence the
attachment was skipped, and reading it that way produces a confident false
negative (it did, while verifying the task reminder on 2026-07-26).

The observation channel that works is a temporary `appendFileSync` to `/tmp`,
at BOTH ends: the producer (`getTaskReminderAttachments` and friends in
`src/agent/attachments/lifecycle.ts`) to see the gate decisions and turn
counters, and the renderer (`normalizeAttachmentForAPI` in
`src/agent/messages/attachments.ts`) to capture the literal text the model
receives. Log the bail reason per branch, not just the success case — that is
what tells you *which* gate closed. `logEvent` is useless here: telemetry is
stubbed out at build time in this fork.

Drive it under tmux with `claudindev` (see the mouse-verification note for the
session recipe); a turn's worth of counters lands in the file in seconds.
Remember the instrumentation lives on top of committed code, so
`git checkout -- <files>` is the clean revert — and rebuild after, since the
launcher runs the bundle.

## Known full-suite flakes & the typecheck baseline

> **The "2 fails in a real checkout" entry was wrong and is retired
> (2026-08-14).** `ProviderModelIndicator.test.ts > readSnapshot` was never a
> parallelism race — bun runs test files in ONE process, so there is no
> parallelism to race. `modelOptions.github.test.ts` captured `providers.js` as
> the live `await import` namespace and "restored" that in `afterAll`, which
> re-installed its own `getAPIProvider: () => 'github'` stub for the rest of the
> run. `renderModelName` then stopped mapping Claude ids. Fixed by taking a
> plain-object copy; the suite is **0 fail** in a real checkout. Treat any
> revival of those two names as a real leak, not as this flake.

In a **git worktree with symlinked `node_modules`** (e.g. `/tmp/...` review
  worktrees): 9 fails — the effort-cycling batch ("Opus 4.8 steps xhigh →
  max", "non-xhigh model… wraps", "numeric session effort…"),
  `deserializeMessagesWithInterruptDetection strips thinking blocks…`, and the
  `main.tsx — boot characterization (Fase 0)` --help snapshots.

So before blaming your change: run the same full suite on **main in the same
directory** and compare failure NAMES. Only a name not in main's set is a
regression signal. (Older list — `ProviderManager.test.tsx` Ollama/Vertex TTY
timeouts, `memory-turn-by-turn-bench` RSS flake — no longer reproduces on
2026-07 main; keep it in mind if they resurface.)

**Typecheck baseline:** `main` reaches **zero** `error TS` since #87, which
retired the fork's ~107 `TS2307` by adding a `.d.ts` next to each absent module
— see [build-system.md](build-system.md) for the import trap that creates. The
backlog used to be thousands deep (4624 on 2026-08-03), so treat any remembered
count as stale, and don't hand-compare: call the **Typecheck** tool, which
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
- [ ] If touching `src/providers/*`: `bun run test:provider`
- [ ] If touching build/telemetry/network: `bun run verify:privacy`
- [ ] If touching output format: snapshots reviewed and updated
- [ ] Typecheck tool reports **zero new** diagnostics (the baseline is empty
      since #87, so anything it reports is yours)
