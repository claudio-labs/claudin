---
name: Plans directory moved to project-local .claudin/plans/, hardened 2026-07-05
description: getPlansDirectory() default changed from ~/.claudin/plans to <cwd>/.claudin/plans; security/integration fixes applied same day
type: project
---

`src/utils/plans.ts` `getPlansDirectory()` default changed from `~/.claudin/plans/` to `<cwd>/.claudin/plans/` (uncommitted on `main` as of 2026-07-05). A 3-agent parallel review (correctness/memoization, security, integration) found real issues, all fixed same session:

1. **Memoization bug (real regression)**: `getPlansDirectory` was a bare argument-less `lodash-es/memoize()`. Harmless with the old cwd-independent default, but with the new cwd-dependent default, subagents running with a `cwd` override (`runWithCwdOverride` in `AgentTool.tsx`, e.g. worktree-isolated subagents) could permanently poison the process-wide cached value to a path nested inside a worktree that later gets deleted. Fixed by keying the memoize on `getCwd()` (`memoize(fn, getCwd)`) instead of adding scattered `.cache.clear()` calls (which would be racy under concurrent subagents anyway).

**Why:** cache correctness depends on which inputs the memoized function actually reads; a cwd-dependent function needs a cwd-keyed cache, not a global one.

**How to apply:** if you see `memoize(fn)` with no resolver wrapping something that reads `getCwd()`/`process.cwd()`, treat it as a bug — resolvers are cheap, use `memoize(fn, () => getCwd())`.

2. **Security: symlink escape (HIGH)**: since the plans dir now lives inside attacker-controllable repo content (vs. the old home-dir default), a malicious repo could plant a `.claudin` symlink escaping the project root. `mkdirSync`/`isSessionPlanFile()` path checks were lexical only (`startsWith`), so this could turn plan-mode's auto-approved read/write into an arbitrary-path primitive. Fixed: after `mkdirSync`, verify via `realpathSync` that the resolved directory is still within the real project root; fall back to the legacy `~/.claudin/plans` (non-project-controlled) location if not.

3. Directory now created/chmod'd `0700` (was default `0755`) — project checkouts are more commonly shared/cloned/backed-up than `$HOME`, and plan content can include secrets discussed mid-session.

4. Plan dir pattern is auto-added to the user's **global** gitignore (`~/.config/git/ignore`, via the existing `addFileGlobRuleToGitignore` helper already used for `CLAUDE.local.md`) so plans don't get accidentally committed in projects that don't already ignore `.claudin/`. Doesn't touch the tracked project `.gitignore`.

5. `cleanupOldPlanFiles()` now sweeps both the new project-local dir and the legacy `~/.claudin/plans/` dir, so orphaned files from before this change still age out after 30 days.

All existing tests green (security-hardening, worktree tools, permissions, planDossier, resumeSession); no dedicated `plans.ts` unit test exists yet.

**Round 2 (same day, second 3-agent adversarial review of the round-1 fixes)** found two more real bugs, both fixed and empirically re-verified:

6. **TOCTOU in the symlink-escape check itself**: the round-1 fix's `catch` block around the `realpathSync` containment check silently logged and left `plansPath` as the *unverified* lexical path if `realpathSync` threw (e.g. attacker's symlink target doesn't exist yet at check time). Since `getPlansDirectory` is memoized per-cwd, that unsafe value then got cached for the rest of the process — a security agent reproduced the full attack empirically (symlink → nonexistent target → check swallows ENOENT → attacker's target materializes moments later → plan file write lands outside the project root). Fixed in `plans.ts` by tracking a `containmentVerified` boolean and falling back to the safe home-dir location whenever the check fails OR can't be completed, never leaving `plansPath` as an unverified value.

**Why:** "verify then use" security checks must fail closed when the verification step itself errors, not just when it returns a negative result — an exception is not evidence of safety.

7. **Stale worktree-cache gap in `AgentTool.tsx`**: `cleanupWorktreeIfNeeded()` (~line 656) deletes a subagent's worktree via `removeAgentWorktree()` after a no-changes run, but never cleared `getPlansDirectory`'s cache. Agent worktree paths are deterministic (`worktreePathFor` in `utils/worktree.ts`), so a later subagent reusing the same slug/path could get served a cached plans-dir path for a directory that no longer exists on disk, breaking plan writes with ENOENT until an unrelated cache-clearing event (main-session worktree enter/exit, `/resume`) happened to reset it. Fixed by adding `getPlansDirectory.cache.clear?.()` right after `removeAgentWorktree(...)` in that function (mirrors the existing pattern in `EnterWorktreeTool.ts`/`ExitWorktreeTool.ts`/`sessionRestore.ts`/`WorktreeExitDialog.tsx`), plus adding `getPlansDirectory` to the existing `plans.js` import in `AgentTool.tsx` (it wasn't imported there before).

Re-verified after round 2: `bun run build`, `bun run typecheck` (no new errors beyond the ~4320 pre-existing baseline), and 369 tests across 13 files (AgentTool, EnterWorktreeTool, ExitWorktreeTool, worktree, security-hardening, planDossier, resumeSession) all green. The TOCTOU fallback was re-confirmed with a standalone repro script mimicking the exact new logic.

**Pattern worth remembering**: a second adversarial review round on your own just-applied fixes reliably surfaces real gaps the first round didn't (matches `feedback-audit-empirical-test-verification.md`) — don't treat "review says it's ok" as terminal after just one pass when the change is security-sensitive.

**Round 3 (same day): added the missing dedicated test coverage.** Neither `plans.ts` nor `cleanup.ts` had a test file before this (confirmed via `ls`). Added `src/utils/plans.test.ts` (9 tests: default path, `plansDirectory` setting honored, lexical-traversal fallback, symlink-escape fallback, the TOCTOU fallback, cwd-keyed memoization, `cache.clear()` recomputation mechanism, gitignore-add-when-inside vs. skip-when-escaped) and `src/utils/cleanup.test.ts` (3 tests for `cleanupOldPlanFiles`: sweep current dir, sweep+merge legacy dir, no double-sweep when both resolve to the same path). Mocking follows the `effort.xhighDefault.test.ts` convention (snapshot real module, `mock.module` the config-source boundary — `settings.js`/`git/gitignore.js`/`plans.js` — restore in `afterAll`, fresh cache-busted import per config variant); all fs/symlink/mtime work is real (tmp dirs via `mkdtempSync`, `CLAUDIN_CONFIG_DIR` env override instead of touching real `~/.claudin`). Empirically verified each test catches its regression: reverting only the round-2 TOCTOU hunk fails exactly the 1 dedicated TOCTOU test (8/9 others still pass); reverting `cleanup.ts` to pre-diff fails exactly the 2 tests that depend on the new `getPlansDirectory()`-based sweep. Full `bun test` after: 6257 pass / 2 fail (both the known `ProviderManager` non-TTY failures, unrelated) / 78 skip across 478 files — no cross-file mock leakage from the new `mock.module` calls.
