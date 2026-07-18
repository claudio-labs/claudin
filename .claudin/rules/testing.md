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

## What NOT to Test

- `dist/cli.mjs` — it's generated, test the source
- `MACRO.*` constants — they're inlined at build time
- Provider presets in `providerConfig.ts` — covered by smoke test
- Feature flags set to `false` — dead code paths

## Known full-suite flakes & the typecheck baseline

A clean tree gives **3 failures** under full `bun test` — none are regression
signals. Re-run the file in isolation to confirm before blaming your change:

1–2. `src/components/ProviderManager.test.tsx` — "Ollama preset auto-detects
   installed models" and "Vertex preset collects gcpProject and gcpRegion" time out:
   Ink TUI interaction tests need a TTY (raw mode) the headless sandbox lacks. Fail
   in isolation too.
3. `scripts/profile/memory-turn-by-turn-bench.test.ts > no late-session RSS
   blow-up` — GC/RSS-pressure flake: under full-suite pressure the first-half slope
   goes negative, making `first.slope * 5` a negative threshold nothing satisfies.
   Passes 3/3 in isolation (`bun --expose-gc test <file>`).

If the failing test NAMES differ from these three, it's a real regression.

**Typecheck baseline:** `bun run typecheck` reports ~4320 pre-existing `error TS` on
`main` (mostly `messagesClient.ts` "possibly undefined", `mcp/doctor.ts`,
`doctorDiagnostic.ts` MACRO refs, `config.ts` implicit any). Compare the COUNT to
main; don't chase absolute errors. `<new-diagnostics>` system-reminders can be STALE
mid-edit snapshots — verify a cited diagnostic with `bun run typecheck 2>&1 | grep
<file>` before acting on it.

## Pre-PR Checklist

- [ ] `bun run build` passes
- [ ] `bun run smoke` passes (version + help)
- [ ] `bun test path/to/changed.test.ts` — focused test passes
- [ ] If touching `src/services/api/*`: `bun run test:provider`
- [ ] If touching build/telemetry/network: `bun run verify:privacy`
- [ ] If touching output format: snapshots reviewed and updated
- [ ] `bun run typecheck` passes (zero tsc errors)
