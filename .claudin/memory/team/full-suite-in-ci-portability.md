---
name: full-suite-in-ci-portability
description: CI-only red tests — the triage testing.md does not hold: compare names with main's run, force the leaked state instead of the order (bun ignores argument order), CI=1 for VCR, a PATH check; the STATE.modelStrings provider leak (#341, 11-08); 07-08 → 11-08 history condensed
type: project
---

CI (`.github/workflows/pr-checks.yml`) has run the full `bun test` on every PR and main push
since 2026-07-08. The general rule is in `.claudin/rules/testing.md` § "Process-global state a
test file must put back": what a file must restore, and why a plain local `bun test` cannot
reproduce an ordering leak. This memory keeps what that section does not.

**Triage, cheapest first:**
1. Compare the failure names with main's latest run (`gh run list --branch main`). The same
   names mean the failures are pre-existing (09-02: main and the PR had the same 16). If main is
   green on the same base, the PR owns them (11-08: 12 red in CI, 0 locally).
2. Set the leaked global by hand instead of recreating the order.
   `CLAUDIN_SIMPLE=1 bun test <victim>` reproduced kimi's 11 and ProviderManager's 3 by name
   (09-02).
3. Use `CI=1` to see the VCR arm. `src/providers/vcr.ts` throws `Fixture missing` only under CI
   with `VCR_RECORD` unset; locally it records or falls through silently.
4. Do not replay CI's order. Bun picks its own file order: `bun test a m z` ran `z` first, and
   within a directory files ran reverse-alphabetically. A full in-order replay of CI's 1171
   files reproduced 0 of 12 (11-08). What proved the leak was forcing its precondition: a probe
   file named to run first (`zzz…`, beside the suspect in the same directory) that sets the
   shared state, plus a copy of the suspect (`mmm…`) with an appended `afterAll` that prints it.
5. Check PATH dependence with `env PATH=/usr/bin:/bin $(which bun) test <file>`. BuildTool/detect
   "node wins over go" needed a global `tsc` (a mise shim here, none on the runner); the fixture
   now carries `node_modules/.bin/tsc`.

**Leaks and traps worth knowing:**
- **`STATE.modelStrings`** (`bootstrap/state/cost.ts`) is filled once per process from whichever
  provider is active at the first `getModelStrings()` read, and no config listener resets it.
  `withRetry.loop.test.ts` read it under an OpenAI profile, so `opus` became gpt-4o for every
  later file (#341). A suite that activates a non-Anthropic profile must save it in `beforeAll`
  and restore it in `afterAll` (`setModelStrings` / `resetModelStringsForTestingOnly`). A victim
  that pins `getAPIProvider` with `mock.module` must also clear it in `beforeEach`/`afterAll`,
  because the mock does not reach a table already cached. A later Bedrock writer was never
  identified.
- **mock.module:** restore from a plain snapshot (`{...(await import(x))}`), never from the live
  `import * as` view. When two call sites must agree on a mockable computation, route both
  through one helper (`getSessionSpillDir()`, 07-08).
- **The shared persistent shell is process-wide.** An earlier test left its cwd outside the
  repo and `git log` exited 128; `runShellCommand.test.ts` now `cd`s first.
- **TTY and snapshots:** `process.stdout.isTTY = true` throws on a pipe, so use
  `Object.defineProperty`. `<REPL>` snapshots pin STATE cwd and `process.cwd()` plus
  `CLAUDIN_NERD_FONT=1` (`replTestHarness.ts`).
- **Timing floors on a loaded runner:** WaitFor "settle" asserts ≥2 polls. One read opens the
  stable window and the next closes it, so 2 is the floor.

**Latent (green now, may resurface when the order shifts):** getProjectTotals "folds last* from
a different session" (`user.test.ts` partial-stubs getSessionId), and ProviderManager
"discovers OpenAI-compatible models" ([[providermanager-tui-tests-fail-non-tty]]).

**History:**
- 07-08: the first full CI run had ~42 red, all pre-existing (checkout path, TERM, an existing
  ~/.claudin, AGENTS.md then gitignored). Green at 03d75a9.
- 09-02: #152 added one test file, and the new order put two latent leakers (cwd, bare mode)
  ahead of their victims. They are now the worked examples in testing.md.
- 11-08: #341 hit the modelStrings leak above.
