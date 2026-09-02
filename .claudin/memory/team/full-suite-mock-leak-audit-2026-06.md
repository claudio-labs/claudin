---
name: Full `bun test` suite green — cross-file mock-leak + stale-baseline audit (2026-06)
description: How the 134→0 full-suite failures were fixed; canonical mock.module teardown pattern and the list of leakers/stale tests, all test-only (no prod changes)
type: project
---

`bun test` (full suite, single worker) failed 134 tests on clean main while each file passed in isolation. Root causes were cross-file mock/state leaks + stale test baselines — NOT production bugs. Fixed 2026-06-17/18, test-files only (24 files), now 6× consecutive clean runs (5656 pass / 0 fail).

**Why:** Bun runs all files in one worker. `mock.restore()` resets `mock()`/`spyOn` spies but does NOT revert `mock.module()`. Also `import * as ns` / bare `await import()` namespaces are LIVE — once mocked, restoring to them re-applies the stub. And mocking a dep of a singleton (e.g. bootstrap/state) re-evaluates it → duplicated module instances.

**How to apply (canonical teardown):**
- Snapshot reals BEFORE mocking: `const real = { ...(await import('./x.js')) }` (plain-object copy, never the live namespace).
- In `afterAll`/`afterEach`, re-mock: `mock.module('./x.js', () => real)` for EVERY module mocked, both the relative form the file uses AND the `src/...` alias.
- `mock.restore()` alone is insufficient if any `mock.module()` was used.

**Leakers fixed (each was missing/broken restore):** attachments.tryGetPDFReference (fsOperations→stat undefined), fullscreen (config getGlobalConfig stub via live namespace), notifier.platform (hooks.js), replTestHarness (removed redundant notifier.js mock — callers already noop'd; pinned MACRO/effort env/useMainLoopModel for deterministic snapshots), lsp/config (errors.js stub dropped isENOENT, live-namespace restore), resumeSession (stubbed bootstrap/state w/ getOriginalCwd→'/tmp/test' + no-op switchSession AND sessionStorage), useApiKeyVerification (bootstrap/state stub w/ only getIsNonInteractiveSession → broke switchSession/getSessionId → flaky cost-tracker), characterization/resumeRoundTrip (setOriginalCwd(tmpDir) not restored), print.test (headless flow left command queue → REPL mount processed orphaned-permission → added resetCommandQueue()).

**Stale baselines updated (prod evolved, tests not):** lazyToolImports (tools.ts now `require()` lazy → drop 'src/tools.ts' from `current`), StartupBanner (anthropic effort now from /effort slider getInitialEffortSetting, #61), regex-redos-scan (isSafeRegex false-positives on `(?:npx\s+)?` and tsc table scanner — empirically linear; added KNOWN_SAFE built-in exceptions), bootCheckpoints.order.txt (+9 trust-onboarding checkpoints, 11g split), officialRegistry (prefetch now gated by essential-traffic default → set ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0), ProviderManager (PRESET_ORDER missing 'xAI / Grok (OAuth)' + providerDiscovery mock missing rankOllamaModels/recommendOllamaModel), measure-token-budget (family-specific env_info raised claude/gpt byte delta to ~1.3%, loosened <0.01→<0.02), REPL.*.snap (regenerated deterministic), memory-turn-by-turn-bench (RSS slope/correlation unreliable under shared worker — assert only well-formed report).

Bisect tip: `mapfile FILES < <(grep -rln '' --include='*.test.ts*' src scripts | grep -v VICTIM | sort)`, then halves + VICTIM last; some leaks are 2-file (a loader + a re-eval trigger).
