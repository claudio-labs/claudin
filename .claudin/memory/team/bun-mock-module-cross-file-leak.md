---
name: Bun mock.module leaks across test files — even into files that run FIRST
description: mock.module('src/platform/config/config.js') in any test file poisons every other file in the same bun test run, including files executed earlier; mock.restore() does not protect them — plus restoring from a LIVE namespace re-installs the mock, and a leaked model.js mock makes getMainLoopModel() ignore overrides
type: project
---

Bun (verified on 1.3.11, 2026-06-12) pre-applies `mock.module` specifier overrides for the whole `bun test` invocation: a `mock.module('./lib.ts', ...)` inside file B's `beforeEach` is already active while file A's tests run, **even when A executes before B** and regardless of `--max-concurrency=1`. `mock.restore()` in B's afterEach does not shield A.

Minimal repro: two files importing `lib.ts`; B mocks it in beforeEach; A's test sees the mocked export.

**Why:** `src/platform/install/startupUpdateCheck.test.ts` mocks `src/platform/config/config.js` (replacing the WHOLE module namespace). Any new test asserting on the *real* `getAutoUpdaterDisabledReason` (or any other config.js export) fails with `undefined`/mock results whenever both files are in the same run — passes when run alone, fails in the suite.

**How to apply:** don't write tests against the real exports of a module that any sibling test file `mock.module`s (config.js is the known case). Instead, extract the logic under test into a module nobody mocks (e.g. the privacy-default exemption went into `privacyLevel.ts` with tests in `privacyLevel.test.ts`), or test through the mocking file's own boundary.

**Second trap — restoring from the live namespace (2026-09-23).** `const real = await import('x')` holds the module's LIVE namespace, which after `mock.module('x', …)` reflects the stub; `afterAll(() => mock.module('x', () => real))` therefore re-installs the mock for every later file. `StreamingToolExecutor.test.ts` left its hanging `runToolUse` installed this way, and a new suite timed out only in the full run (fixed 7ed47a1c). Snapshot a plain copy BEFORE mocking — `const real = { ...(await import('x')) }` — as `teamMemPrompts.test.ts` does.

**model.js (2026-09-24).** A dozen suites mock `src/providers/model/model.js`, and under the full run something leaves `getMainLoopModel()` ignoring `setMainLoopModelOverride`: a test that set `'gpt-5'` passed alone and failed in the suite. The leaking file was not located. Test through a pure seam that takes the model or family as an argument (`isV2PromptSwitchOn(env, family)` in `toolPromptTier.ts`) and pin the wiring on the source.
