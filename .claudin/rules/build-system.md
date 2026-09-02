---
paths:
  - "scripts/build/build.ts"
  - "scripts/build/no-telemetry-plugin.ts"
  - "scripts/build/feature-flags-source-guard.test.ts"
  - "src/agent/prompts/prompts.ts"
  - "scripts/bench/tokens/dump-system-prompt.ts"
---
# Build System — Claudin Development Rules

`scripts/build/build.ts` is not a thin wrapper. It preprocesses source, inlines
constants, and stubs modules — so it affects every change. Read this before
touching the build, the feature-flag set, or the telemetry stubs.

The CLI is a **single-file bundle**: `src/platform/entrypoints/cli.tsx` → `dist/cli.mjs`,
launched by `bin/claudin`. There is no dev runner that bypasses the bundle —
**always `bun run build` after a source change**; the launcher runs `dist/cli.mjs`,
not source.

## What the build does (six things that bite)

1. **Source pre-processing (`preProcessSources`).** Source files are mutated **in
   place**, then restored: `feature('FLAG')` calls become boolean literals from
   the `featureFlags` map, and the `import { feature } from 'bun:bundle'` line is
   stripped. Originals are
   restored in a `finally` block (and on `SIGINT`/`SIGTERM`). A `SIGKILL`
   mid-build can leave files preprocessed — `git status` shows the damage.
   > ⚠️ **Never commit a file with a literal `true`/`false` where `feature('X')`
   > should be.** Run `git diff` after any killed build. This preprocessing
   > exists because Bun ≥1.3.9 resolves `bun:bundle` natively before plugins can
   > intercept it.
2. **`tengu_*` event-name stripping**, in that same pass. Telemetry is already a
   no-op (see #5), but the ~1000 event-name literals survive minification as
   arguments to the stubs, so they are blanked to `''`. Scope is **only the first
   argument of `logEvent`/`logEventAsync`**: a `tengu_*` string handed to
   `checkGate*`/`getFeatureValue*`/`getDynamicConfig*` is a feature-gate KEY, and
   blanking one would silently change which default that gate resolves to. Names
   reached through a variable are left alone for the same reason. Measured on a
   clean `dist/chunks`: 832 distinct names → 205, all 54 gate keys among the
   survivors. Verify with `rm -rf dist/chunks && bun run build`, never against a
   stale generation (see #6).
3. **`MACRO.*` constants** (`MACRO.VERSION`, `MACRO.DISPLAY_VERSION`,
   `MACRO.BUILD_TIME`, …) are inlined via `define`. `MACRO.VERSION` is pinned to
   `99.0.0` to pass first-party minimum-version guards; the **real** version is
   `MACRO.DISPLAY_VERSION`. Never compare against `MACRO.VERSION` for version logic.
4. **Stub modules.** Native addons, missing internal Anthropic packages
   (`@ant/computer-use-mcp`, `daemon/*`, `cli/bg`, `self-hosted-runner`, …),
   `.md`/`.txt` imports, and `react/compiler-runtime` are redirected to inline
   stubs. A pre-scan walks `src/` for unresolved `.js` relative imports /
   `src/agent/tasks/*` paths / dynamic `require`/`import` and stubs them automatically.
   > A new top-level Anthropic-internal import still builds (the pre-scan stubs
   > it) but is a **no-op at runtime**. Gate it behind `feature()` so it only
   > loads when intentionally enabled.
5. **`noTelemetryPlugin`** (`scripts/build/no-telemetry-plugin.ts`) replaces analytics,
   GrowthBook, Datadog, BigQuery, OTel session tracing, the auto-updater, and
   feedback/transcript sharing with stubs. `bun run verify:privacy` enforces this
   on the bundle — run it for any build/telemetry/network change.
6. **Path alias.** `tsconfig.json` maps `src/*` → `./src/*`. Both `src/...` and
   relative imports work; prefer the `src/...` form.

### A declaration-only module has to stay a relative import

89 files under `src/` are a `.d.ts` with no `.ts`/`.tsx` beside them — 85 of them
added by #87 to retire the fork's `TS2307`. They declare modules this fork never
received, and they resolve **for tsc and for nothing else**.

**Every export in them is `any` on purpose.** A concrete invented shape lets tsc
walk into the caller and raise `TS2339` on properties the invention lacks — an
earlier attempt measured worse than the diagnostic it was replacing. They buy
**no** type safety (an unresolved import is already `any`), they only retire the
error. Nor do they mean the code is unreachable: `src/commands/commands.ts`
imports 19 of them eagerly and does hit the `() => null` stub at runtime.

The pre-scan in #4 is what keeps the build green over them, and it fires on
exactly one shape: `scripts/build/build.ts:579` registers a module as missing when the
specifier both ends in `.js` and starts with `./` or `../`, testing for a
`.ts`/`.tsx` sibling that a `.d.ts` does not provide. So the relative form is
stubbed to a noop and the bundle builds. The `src/…` alias form is never scanned
at all — Bun's resolver reaches it directly and the build dies with
`Could not resolve`.

Item 6 above therefore has one exception, and it is the opposite of what a
mechanical alias pass will do: **an import of a declaration-only module keeps its
`../` and stays relative.** Aliasing one trades a green build for a hard resolver
failure. Moving the importing file without re-deriving that `../` is worse than
it looks — the specifier silently stops naming the declaration and becomes a real
`TS2307`, a class that is invisible on any base where the target did not resolve
before the move either (742 of them in PR #88, from a single directory move).

`bun run build:strict` pins the set: `scripts/build/missing-imports-baseline.json`
records the 103 specifiers this fork legitimately stubs, and the build fails on
any new one, naming the file that referenced it. It is what tells a deliberate
stub apart from an import that broke. A plain `bun run build` prints the count
and, when it matches the baseline exactly, says so — that line is the expected
steady state, not a warning. `*.test.ts(x)` is skipped by the scan: a fixture
string such as `'import { cfg } from "./a.js"'` is indistinguishable from a real
import to the regex scanner, and a test file never reaches the bundle anyway.

**Re-capture the baseline as part of any tree-wide move**
(`CLAUDIN_STRICT_IMPORTS=capture bun run build`). It records *resolved*
specifiers, so moving an importer invalidates its entry: the 2026-08 reorg
captured at group 3 of N and left `build:strict` failing on 53 unbaselined
specifiers and 55 baselined ones that no longer existed, while a plain
`bun run build` stayed green and merely printed the counts. Diff the old and new
sets by module **basename** before trusting a re-capture — an identical set means
paths moved, a new name means an import actually broke.

### A lazy command chunk that fails to load is silently inert

`load: () => import('src/commands/<name>/<name>.js')` puts each command in its
own chunk. If that chunk throws while loading, nothing surfaces: the slash
command is accepted, the prompt clears, and **no** UI, message or error appears
— indistinguishable from a command that chose to render nothing. `/import`
shipped that way and only the runtime walkthrough caught it.

The cause was a **bare package specifier**: `from 'jsonc-parser'` resolves to an
entry whose internal `require('./impl/format')` does not survive bundling, while
`from 'jsonc-parser/lib/esm/main.js'` — what `src/shared/data/json.ts` already
used — does. So prefer the deep specifier an existing importer proved, and when
adding a dependency to a lazily-loaded command, load its built chunk once:

```bash
node -e "import('./dist/chunks/<name>-<hash>.mjs').then(m=>console.log('OK',Object.keys(m))).catch(e=>console.log('FAIL:',e.message))"
```

A working chunk prints its exports (`call`, …). This is the only cheap check —
`bun run build` is green either way, the unit tests import source rather than
the bundle, and `bun run smoke` only asserts `--version`.

### Two declaration files to keep current

`src/globals.d.ts` declares the `MACRO.*` constants item 2 inlines: a member
here that is missing from the `define` map ships as a `ReferenceError`.
`src/stubbed-modules.d.ts` declares the packages and `.md`/`.txt` assets item 3
replaces with stubs. And when a typecheck drop looks too good to be true, check
for `TS1xxx` first — one syntax error in a generated `.d.ts` makes tsc skip
semantic analysis for the whole program and report near-zero.

## What the `--compile` binary is NOT

`CLAUDIN_COMPILE=1` produces `bin/claudin.exe` via `bun --compile`, and that
binary — not the Node bundle — is what a user runs. `install.cjs` hardlinks it
over the wrapper package's bin stub, so `claudin` execs it directly;
`cli-wrapper.cjs` states this at its own top (*"bin/claudin.exe, so this file is
never invoked"*). Four consequences, each measured on the shipped binary, each
of which has already produced code that reads as if it worked. A fifth entry
below corrects one of them, because the first measurement was taken wrong:

- **`bin/claudin` does not run.** Every knob in the launcher's heap-bump
  re-exec — `--max-old-space-size`, `--expose-gc`, the jemalloc `LD_PRELOAD`,
  the `MALLOC_*_THRESHOLD_` tuning — is absent from the binary's environment.
  The launcher is not dead code (it still governs `node dist/cli.mjs`), but
  nothing written there reaches the default install.
- **`UV_THREADPOOL_SIZE` DOES size Bun's I/O pool.** An earlier revision of this
  file said it was inert. That was measured on an *idle* process, where no pool
  thread exists at any setting — the pool is created **lazily, on first file
  I/O**. Under load it plainly works: `2`→13 threads, `4`→15, `8`→19, `24`→28
  (the value `1` is ignored). Default size is `nproc`, so a 16-core box runs ~14
  of them and the process shows ~26 threads in total. They cost **~4 MB RSS each**
  (mimalloc per-thread arenas) and **zero CPU** — they are idle, because the tools
  spawn child processes (`rg`) rather than queueing on a pool. Capping at `4` saved
  ~50 MB of RSS with *no* CPU change across five reps; capping at `2` made
  concurrent I/O ~1.8× slower. `BUN_JSC_numberOfGCMarkers=N` works the same way
  and yields `N-1` `HeapHelper` threads (~410 KB each).
- **Neither can be set from inside the process.** Both are read at VM init,
  before any of our JS runs, so `process.env.X = …` is inert — and so is the
  compiled binary's `.env` autoload (`autoloadDotenv` defaults to **true**,
  `bun-types/bun.d.ts:3036`), which lands too late for threads. Since the binary
  has no launcher to export them, a **re-exec of self** is the only lever it has —
  and that was measured and **rejected**. Bun exposes no `process.execve`
  (verified `undefined` on 1.3.11), so the parent cannot replace its own image:
  it stays resident blocked in `spawnSync` for the whole session. Measured
  parent 65 MB **plus** child 70 MB against 70 MB un-re-exec'd, which more than
  erases the ~50 MB the cap saves. `bin/claudin:212-218` documents the same
  trade from the other side — on the Node path `execve` exists, so there the
  re-exec is free and the launcher takes it. Do not re-propose the cap for the
  binary until Bun ships `execve`.
- **`globalThis.gc` does not exist under Bun** unless started with
  `bun --expose-gc`, which nothing does. Use `hintGc()` from
  `src/shared/proc/gc.ts`; it picks `Bun.gc(sync)` or the exposed global per
  runtime. A bare `globalThis.gc?.()` was a silent no-op on the binary at both
  of the sites that used it, one of which exists to release ~250 MB after a
  wide subagent fan-out. Note the trap when verifying this class of fix: almost
  every `profile:*` script runs `bun --expose-gc`, which makes the global exist
  and hides the bug — measure with a plain `bun run`.
- **A worker cannot be loaded from a file.** The worker's source is not in the
  binary's embedded VFS, so `new Worker(new URL('./w.ts', import.meta.url))`
  hangs with no error, and `node:worker_threads` fails with
  `ModuleNotFound resolving "/$bunfs/root/w.ts"` — both work fine under plain
  `bun`, so this only shows up after `--compile`. Adding the worker as a second
  entrypoint does not help. What works is a worker whose source is an inlined
  string, loaded through a Blob or `data:` URL; that path measured 3.5× on four
  workers with ~3 ms of spawn overhead and free structured-clone of 1 MB.
  This is the same VFS limitation as the static-`require` rule in
  [typescript-patterns.md](typescript-patterns.md).

No such pool exists today, deliberately. The obvious candidate was `scanSymbols`,
and it does not clear the bar: `SYMBOLS_MAX_FILES = 50`
(`src/tools/GrepTool/symbolsOutput.ts`) caps a symbols-mode Grep at 50 files and
the scanner measures **20.1 MB/s (0.413 ms/file)** over `src/`, so the worst case
is ~21 ms and a pool would save ~15 ms of it. Re-open the question if that cap
moves, not before.

## Feature Flags

Build-time flags live in `featureFlags` in `scripts/build/build.ts`. Most
Anthropic-internal subsystems are **disabled** because their source isn't
mirrored or they need Anthropic infrastructure: `VOICE_MODE`, `KAIROS`,
`PROACTIVE`, `DAEMON`, `BG_SESSIONS`, `WEB_BROWSER_TOOL`, `MCP_SKILLS`, …

Enabled flags drive real code paths in the open build: `COORDINATOR_MODE`,
`BUILTIN_PLAN_AGENT`, `EXTRACT_MEMORIES`, `ULTRATHINK`, `TOKEN_BUDGET`,
`HISTORY_PICKER`, `HOOK_PROMPTS`, `AGENT_WORKFLOWS`, …

`BRIDGE_MODE` is the one enabled flag whose subsystem still needs a credential
the open build cannot mint on its own: it builds Remote Control in
(`remote-control`/`rc`, `/bridge`, BriefTool's upload path), and
`hasBridgeCredential()` then decides at runtime whether any of it opens — a
claude.ai web-login OAuth token with the `user:profile` scope, or the
`CLAUDE_BRIDGE_OAUTH_TOKEN` dev override. Without one, `/bridge` reports the
reason from `getBridgeDisabledReason()` instead of connecting.

When in doubt whether a feature is alive, check the flag in `build.ts` before
chasing dead code. **New Anthropic-internal features go behind `feature('FLAG')`
— never gate build-time features with runtime env vars.**

### A source-side render reads every flag as `false`

`feature()` cannot be resolved outside the build. Bun resolves `bun:bundle`
natively before any mock or plugin, so `mock.module('bun:bundle', …)` in
`src/stubs/test-preload.ts` is **inert** — under `bun run` and `bun test` all 50
flags read `false`, including the 34 that ship `true`. Anything rendered from
source is therefore the flag-off shape, not what the binary sends. The worked
example is the system prompt: a source dump is missing ~800 tokens of steering
(`WORK_CONTRACT`, `ANTI_NARRATION`, `LEAN_TOOL_PROMPTS`, …) and a parity pass has
already reported shipped sections as missing because of it. To see the real
thing, ask the built bundle: `bun scripts/bench/tokens/dump-system-prompt.ts
--flags=ship` (after `bun run build`). Same trap for any other flag-gated
construct you render in a script or a test.

## Rules

1. Never commit `true`/`false` where `feature('X')` should be (see #1 above).
2. `MACRO.VERSION` is `99.0.0` — use `MACRO.DISPLAY_VERSION` for real version logic.
3. New external/internal imports are auto-stubbed → gate real features with `feature()`.
4. Always `bun run build` after changes; the launcher runs the bundle, not source.
5. **`dist/` is code-split — search the tree, not `dist/cli.mjs`.** The entry file
   holds only the fast paths (`--version`) and dynamic imports; everything else
   lands in `dist/chunks/<Name>-<buildId>-<hash>.mjs`. Grepping `dist/cli.mjs` for
   a string you just added returns 0 for code that shipped perfectly — search all
   of `dist/`, or just run the built binary. (`verify:privacy` reporting "1398
   bundle file(s)" is the tell.) The build GCs `dist/chunks` down to the **3 most
   recent generations**, so a stale fold can still match for two more rebuilds:
   `rm -rf dist/chunks` before verifying a `feature()` fold.
6. **A rebuild eventually breaks a claudin session running from this checkout.**
   Lazily-imported chunks are resolved from disk at call time, so once the GC
   prunes the generation a live session booted from, its next lazy import fails
   with `Cannot find module '/…/dist/chunks/processSlashCommand-<oldgen>-….mjs'`
   — skills and slash commands die first. It takes three rebuilds, not one, and
   it is not a code regression: restart `claudindev`.

## Invariant tests (run when touching the build)

```bash
bun test scripts/build/feature-flags-source-guard.test.ts    # feature() flag consistency
bun test scripts/bench/tokens/measure-tool-schemas.test.ts   # tool schema size
bun test scripts/build/no-telemetry-growthbook-stub.test.ts  # no phone-home
bun test scripts/verify/pr-intent-scan.test.ts               # PR security scan
bun run verify:privacy                                       # scan dist/ for phone-home
```
