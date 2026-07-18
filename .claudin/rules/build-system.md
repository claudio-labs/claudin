---
paths:
  - "scripts/build.ts"
  - "scripts/no-telemetry-plugin.ts"
  - "scripts/feature-flags-source-guard.test.ts"
---
# Build System — Claudin Development Rules

`scripts/build.ts` is not a thin wrapper. It preprocesses source, inlines
constants, and stubs modules — so it affects every change. Read this before
touching the build, the feature-flag set, or the telemetry stubs.

The CLI is a **single-file bundle**: `src/entrypoints/cli.tsx` → `dist/cli.mjs`,
launched by `bin/claudin`. There is no dev runner that bypasses the bundle —
**always `bun run build` after a source change**; the launcher runs `dist/cli.mjs`,
not source.

## What the build does (five things that bite)

1. **`feature()` flag preprocessing.** Source files are mutated **in place**:
   `feature('FLAG')` calls become boolean literals from the `featureFlags` map,
   and the `import { feature } from 'bun:bundle'` line is stripped. Originals are
   restored in a `finally` block (and on `SIGINT`/`SIGTERM`). A `SIGKILL`
   mid-build can leave files preprocessed — `git status` shows the damage.
   > ⚠️ **Never commit a file with a literal `true`/`false` where `feature('X')`
   > should be.** Run `git diff` after any killed build. This preprocessing
   > exists because Bun ≥1.3.9 resolves `bun:bundle` natively before plugins can
   > intercept it.
2. **`MACRO.*` constants** (`MACRO.VERSION`, `MACRO.DISPLAY_VERSION`,
   `MACRO.BUILD_TIME`, …) are inlined via `define`. `MACRO.VERSION` is pinned to
   `99.0.0` to pass first-party minimum-version guards; the **real** version is
   `MACRO.DISPLAY_VERSION`. Never compare against `MACRO.VERSION` for version logic.
3. **Stub modules.** Native addons, missing internal Anthropic packages
   (`@ant/computer-use-mcp`, `daemon/*`, `cli/bg`, `self-hosted-runner`, …),
   `.md`/`.txt` imports, and `react/compiler-runtime` are redirected to inline
   stubs. A pre-scan walks `src/` for unresolved `.js` relative imports /
   `src/tasks/*` paths / dynamic `require`/`import` and stubs them automatically.
   > A new top-level Anthropic-internal import still builds (the pre-scan stubs
   > it) but is a **no-op at runtime**. Gate it behind `feature()` so it only
   > loads when intentionally enabled.
4. **`noTelemetryPlugin`** (`scripts/no-telemetry-plugin.ts`) replaces analytics,
   GrowthBook, Datadog, BigQuery, OTel session tracing, the auto-updater, and
   feedback/transcript sharing with stubs. `bun run verify:privacy` enforces this
   on the bundle — run it for any build/telemetry/network change.
5. **Path alias.** `tsconfig.json` maps `src/*` → `./src/*`. Both `src/...` and
   relative imports work; prefer the `src/...` form.

## Feature Flags

Build-time flags live in `featureFlags` in `scripts/build.ts`. Most
Anthropic-internal subsystems are **disabled** because their source isn't
mirrored or they need Anthropic infrastructure: `VOICE_MODE`, `KAIROS`,
`PROACTIVE`, `BRIDGE_MODE`, `DAEMON`, `BG_SESSIONS`, `WEB_BROWSER_TOOL`,
`MCP_SKILLS`, …

Enabled flags drive real code paths in the open build: `COORDINATOR_MODE`,
`BUILTIN_EXPLORE_PLAN_AGENTS`, `EXTRACT_MEMORIES`, `ULTRATHINK`, `TOKEN_BUDGET`,
`HISTORY_PICKER`, `HOOK_PROMPTS`, `AGENT_WORKFLOWS`, …

When in doubt whether a feature is alive, check the flag in `build.ts` before
chasing dead code. **New Anthropic-internal features go behind `feature('FLAG')`
— never gate build-time features with runtime env vars.**

## Rules

1. Never commit `true`/`false` where `feature('X')` should be (see #1 above).
2. `MACRO.VERSION` is `99.0.0` — use `MACRO.DISPLAY_VERSION` for real version logic.
3. New external/internal imports are auto-stubbed → gate real features with `feature()`.
4. Always `bun run build` after changes; the launcher runs the bundle, not source.
5. Verifying a `feature()` fold in the bundle: `rm -rf dist/chunks` first — code is
   code-split into `dist/chunks/*.mjs` and stale hashed chunks are never pruned, so
   a grep can match an old fold.

## Invariant tests (run when touching the build)

```bash
bun test scripts/feature-flags-source-guard.test.ts   # feature() flag consistency
bun test scripts/measure-tool-schemas.test.ts          # tool schema size
bun test scripts/no-telemetry-growthbook-stub.test.ts  # no phone-home
bun test scripts/pr-intent-scan.test.ts                # PR security scan
bun run verify:privacy                                 # scan dist/cli.mjs for phone-home
```
