---
name: Bun mock.module leaks across test files — even into files that run FIRST
description: mock.module('src/utils/config.js') in any test file poisons every other file in the same bun test run, including files executed earlier; mock.restore() does not protect them
type: project
---

Bun (verified on 1.3.11, 2026-06-12) pre-applies `mock.module` specifier overrides for the whole `bun test` invocation: a `mock.module('./lib.ts', ...)` inside file B's `beforeEach` is already active while file A's tests run, **even when A executes before B** and regardless of `--max-concurrency=1`. `mock.restore()` in B's afterEach does not shield A.

Minimal repro: two files importing `lib.ts`; B mocks it in beforeEach; A's test sees the mocked export.

**Why:** `src/utils/startupUpdateCheck.test.ts` mocks `src/utils/config.js` (replacing the WHOLE module namespace). Any new test asserting on the *real* `getAutoUpdaterDisabledReason` (or any other config.js export) fails with `undefined`/mock results whenever both files are in the same run — passes when run alone, fails in the suite.

**How to apply:** don't write tests against the real exports of a module that any sibling test file `mock.module`s (config.js is the known case). Instead, extract the logic under test into a module nobody mocks (e.g. the privacy-default exemption went into `privacyLevel.ts` with tests in `privacyLevel.test.ts`), or test through the mocking file's own boundary.
