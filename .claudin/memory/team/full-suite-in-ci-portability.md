---
name: Running the full bun test suite in CI exposes env/order-dependent test bugs
description: Since 2026-07-08 CI runs `bun test` (not just smoke); this unmasked ~42 pre-existing non-portable tests. Root causes + fixes catalogued here.
type: project
---

CI (`.github/workflows/pr-checks.yml`) now runs the full `bun test` on every PR
and main push, not just `smoke`. The first full run failed ~42 tests that pass
in the local tree — all PRE-EXISTING non-portability, not regressions. Local
passes because the dev machine happens to match the recorded assumptions
(checkout path, TERM, an existing ~/.claudin, AGENTS.md present) AND because
Bun's file execution order (readdir, path-dependent) masks the cross-file mock
leaks in the local order but unmasks them under CI's order.

**Reproduce locally:** clone to a *different path* reusing node_modules
(`git clone file://<repo> /tmp/ci-repro && ln -s <repo>/node_modules ...`) — the
different path gives a different Bun file order and reproduces the leaks; a fresh
checkout also drops the gitignored AGENTS.md. Fixing the leaker dropped
`/tmp/ci-repro` failures 19→6.

**Root causes + fixes (42→6 so far):**
- `process.stdout.isTTY = true` throws "readonly property" when stdout is a pipe
  (CI). Use `Object.defineProperty`. (terminal.test.ts)
- `<REPL>` snapshots baked the dev cwd + TERM: pin STATE cwd AND `process.cwd()`
  (the startup logo `StartupScreen.ts` reads process.cwd() directly, not STATE)
  to `join(homedir(),'projects','claudin')`, and set `CLAUDIN_NERD_FONT=1` (the
  footer status line renders bracketed ASCII `[ ◐ medium ]` without nerd-font
  glyphs, seamless Powerline with — `hasNerdFontGlyphs()` keys off TERM). All in
  replTestHarness.ts setupReplMocks/teardownReplMocks.
- **mock.module leaks — `mock.restore()` does NOT revert mock.module()**; a
  partial stub (missing exports) bleeds into sibling files. Snapshot the real
  module (`{ ...(await import(x)) }`) and re-install it in afterEach/afterAll:
  - startupUpdateCheck.test.ts leaked config/doctorDiagnostic/autoUpdater/
    latestVersionCache/settings (only mock.restore()) → broke latestVersionCache
    + subscribeLatestVersion.
  - teamMemPrompts.test.ts had NO teardown → leaked git/paths/teamMemPaths/state
    → broke getAutoMemPath + isTeamMemLikelyGitIgnored + getProjectTotals.

**RESOLVED — CI green as of 03d75a9 (42→0):**
- getAttachments claude_md_delta ×2 — AGENTS.md is `.gitignore`d+untracked
  (c6d8e44) so a fresh CI clone lacks the project doc. Did NOT re-track it; made
  the omit-gate tests hermetic via a scoped getUserContext mock returning a fixed
  claudeMd (attachments.orchestrator.test.ts). Repro CI state locally with
  CLAUDE_CODE_DISABLE_CLAUDE_MDS=1.
- useApiKeyVerification timeout — the REPL harness (replTestHarness.ts) stubbed
  useApiKeyVerification to `{status:'valid'}` but teardown only restored
  useMainLoopModel; the stub leaked into the hook's own test. Snapshot+restore it
  in teardownReplMocks.
- unlinkSessionSpillDir ×2 — TWO distinct leaks: (a) claudinInstallSurfaces mocked
  fs/promises rm→no-op, restore used the LIVE `import * as` namespace (already
  the stub) → snapshot a plain copy instead; (b) real root: a leaked partial
  getProjectDir/getClaudinConfigHomeDir stub fragments config-root resolution so
  the test's independently-derived path (CLAUDIN_CONFIG_DIR) diverged from
  unlinkSessionSpillDir's (~/.claudin). Fix that isn't whack-a-mole: extracted
  getSessionSpillDir() and had BOTH the deleter and the test build the path
  through it (same binding can't diverge). `signal for A` was a false positive —
  grep matched "(fail)" inside the test name "A(fail)"; it passes.
- `git log … --oneline` exit 128 — NOT git ownership: the shared persistent shell
  is a process-wide singleton and an earlier test left its cwd outside the repo,
  so git ran in a non-repo dir ("fatal: not a git repository", message on the
  merged stdout, stderr empty). Fix: `cd process.cwd()` through the same shell
  before the rewrite (runShellCommand.test.ts).

**KEY bun mock.module lessons:** (1) restore with a PLAIN snapshot
(`{...(await import(x))}`), never the live `import * as` view. (2) mock.module
propagation is asymmetric/unreliable cross-file — a leaked mock reaches an
already-imported binding but a later restore may not revert it in place; a fresh
(cache-busted) import or a shared helper is the reliable escape. (3) When two
call sites must agree on a mockable computation, route both through one exported
helper instead of re-deriving.

**Latent order-dependent leaks (green now, may resurface on order shift):**
getProjectTotals "folds last* from a different session" (bootstrap/state
getSessionId fragmentation — user.test.ts partial-stubs it) and ProviderManager
"discovers OpenAI-compatible models" (see providermanager-tui-tests memory).
