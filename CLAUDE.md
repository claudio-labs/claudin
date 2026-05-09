# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Coding Rules

Patterns, error handling, and anti-patterns are defined in `.claude/rules/` (auto-loaded into context):

- [typescript-patterns.md](.claude/rules/typescript-patterns.md) — TypeScript idioms, error handling, zod schemas, provider abstraction, privacy rules
- [testing.md](.claude/rules/testing.md) — Bun test runner, snapshot testing, provider tests, pre-PR checklist
- [search-strategy.md](.claude/rules/search-strategy.md) — Module map, navigation patterns, common Grep/Glob queries

## Project Overview

Claudio is an open-source coding-agent CLI forked from the Claude Code codebase, retargeted to work across many model providers (Anthropic, OpenAI-compatible, Gemini, Mistral, GitHub Copilot, Codex OAuth, Ollama, Bedrock, Vertex, Foundry, etc.). The runtime is the same agent loop (tools, MCP, slash commands, streaming, sub-agents) but provider selection and credentials are managed entirely from inside the REPL via `/provider`, with profiles persisted under `~/.claudio/settings.json`.

The project is **not affiliated with Anthropic**. Telemetry/phone-home paths from upstream are replaced with no-op stubs at build time (see `scripts/no-telemetry-plugin.ts`) and `bun run verify:privacy` enforces this on the bundle.

## Common Commands

Build, run, test:

```bash
bun install                 # install deps (uses bun.lock)
bun run build               # bundle src/entrypoints/cli.tsx → dist/cli.mjs
bun run dev                 # build + node dist/cli.mjs
bun run smoke               # build + --version sanity check
bun run typecheck           # tsc --noEmit
bun test                    # full Bun test runner suite (~198 test files)
bun test path/to/file.test.ts  # focused single-file test
bun run test:provider       # provider integration tests (api/* + utils/context)
bun run test:coverage       # lcov + heatmap at coverage/index.html
bun run verify:privacy      # scan dist/cli.mjs for banned phone-home patterns
bun run build:verified      # build + verify:privacy
```

gRPC headless mode:

```bash
bun run dev:grpc            # start gRPC server on localhost:50051 (proto: src/proto/claudio.proto)
bun run dev:grpc:cli        # streaming CLI client over gRPC
```

After install (npm) or local build, the launcher is `bin/claudio` — it requires `dist/cli.mjs` to exist; otherwise it prints a "build first" hint. There is no separate dev runner that bypasses the bundle.

## Build System (Critical)

`scripts/build.ts` is not a thin wrapper — it does several things that affect every change:

1. **`feature()` flag preprocessing.** Source files are mutated in place: `feature('FLAG')` calls become boolean literals from the `featureFlags` map, and the `import { feature } from 'bun:bundle'` line is stripped. The originals are restored in a `finally` block (and on `SIGINT`/`SIGTERM`). If a build is killed with `SIGKILL`, files may be left preprocessed — `git status` will show the damage. **Never commit a file that contains a literal `true`/`false` where `feature('X')` should be.** This preprocessing exists because Bun ≥1.3.9 resolves `bun:bundle` natively before plugins can intercept it.
2. **`MACRO.*` constants** (`MACRO.VERSION`, `MACRO.DISPLAY_VERSION`, `MACRO.BUILD_TIME`, etc.) are inlined via `define`. `MACRO.VERSION` is intentionally pinned to `99.0.0` to pass first-party minimum-version guards; the real version is `MACRO.DISPLAY_VERSION`.
3. **Stub modules.** Native addons, missing internal Anthropic packages (`@ant/computer-use-mcp`, `daemon/*`, `cli/bg`, `self-hosted-runner`, etc.), `.md`/`.txt` imports, and `react/compiler-runtime` are all redirected to inline stubs. A pre-scan walks `src/` to find any unresolved `.js` relative imports / `src/tasks/*` paths / dynamic `require`/`import` and adds them to the missing-module set automatically.
4. **`noTelemetryPlugin`** (`scripts/no-telemetry-plugin.ts`) replaces analytics, GrowthBook, Datadog, BigQuery, OTel session tracing, auto-updater, and feedback/transcript sharing modules with stubs.
5. **Path alias.** `tsconfig.json` maps `src/*` to `./src/*`. Both `src/...` and relative imports work; many files use the `src/...` form.

If you add a new top-level Anthropic-internal import that isn't mirrored in this repo, the build will still succeed (the pre-scan stubs it) but the feature will be a no-op at runtime. Gate it behind a `feature()` flag so it only loads when intentionally enabled.

## Feature Flags

Build-time flags live in `featureFlags` in `scripts/build.ts`. Most Anthropic-internal subsystems (`VOICE_MODE`, `KAIROS`, `PROACTIVE`, `BRIDGE_MODE`, `DAEMON`, `BG_SESSIONS`, `WEB_BROWSER_TOOL`, `MCP_SKILLS`, etc.) are **disabled** because their source isn't mirrored or they require Anthropic infrastructure. Flags that are enabled drive real code paths in the open build (e.g. `COORDINATOR_MODE`, `BUILTIN_EXPLORE_PLAN_AGENTS`, `EXTRACT_MEMORIES`, `ULTRATHINK`, `TOKEN_BUDGET`, `HISTORY_PICKER`, `HOOK_PROMPTS`).

When in doubt about whether a feature is alive, check the flag in `build.ts` before chasing dead code.

## Architecture

Single entrypoint, single-file bundle. The CLI is bundled to `dist/cli.mjs` and launched by `bin/claudio`.

- `src/entrypoints/cli.tsx` — process entrypoint. Polyfills `globalThis.File` for older Node, sets defaults like `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true`, fast-paths `--version`, then dynamically imports the rest. Most imports are deferred so cold paths (version, errors, simple flags) don't pay full module-eval cost.
- `src/QueryEngine.ts` + `src/query.ts` — the agent loop. Drives the model, tool dispatch, streaming SDK message generation (`SDKMessage`, `SDKStatus`, etc. from `src/entrypoints/agentSdkTypes.ts`), accumulates usage, and handles compaction/permission/coordination flows.
- `src/Tool.ts` — central tool type system: `Tool`, `Tools`, `ToolUseContext`, progress types, permission types. Tools live under `src/tools/<Name>/` with their own input schema (zod), prompt, and execute handler. The tool registry is built dynamically based on context (sandbox, plan mode, coordinator, MCP, etc.).
- `src/services/api/` — provider abstraction. `client.ts` builds the right SDK (Anthropic, Bedrock, Vertex, Foundry, OpenAI shim, Codex shim) based on `activeProvider.ts`. Critical files:
  - `openaiShim.ts` (~2.2k lines) — translates Anthropic message/tool format to OpenAI Chat Completions for any OpenAI-compatible base URL (DeepSeek, Groq, OpenRouter, LM Studio, Together, etc.).
  - `codexShim.ts` — adapter for ChatGPT OAuth ("codex" provider).
  - `providerConfig.ts` (~925 lines) — preset definitions, profile schema, credential storage, OAuth token handling.
  - `withRetry.ts`, `errors.ts`, `errorUtils.ts` — retry + error classification (model-specific, including OpenAI-compatibility quirks).
- `src/commands/` — slash commands. Each subdir is one `/command`; they're discovered and registered through `src/commands.ts`. Notable: `/provider`, `/provider doctor`, `/provider migrate`, `/review`, `/security-review`, `/plan`, `/resume`, `/usage`, `/cost`, `/mcp`, `/skills`, `/ide`, `/hooks`, `/permissions`. Many flags are gated behind `createMovedToPluginCommand.ts`.
- `src/tools/` — built-in tools: file IO (`FileReadTool`, `FileEditTool`, `FileWriteTool`, `NotebookEditTool`), search (`GrepTool`, `GlobTool`), shell (`BashTool`, `PowerShellTool`, `REPLTool`), agents/tasks (`AgentTool`, `TaskCreateTool`, …), MCP (`MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `McpAuthTool`), planning (`EnterPlanModeTool`, `ExitPlanModeTool`, `VerifyPlanExecutionTool`), web (`WebFetchTool`, `WebSearchTool`), workflow (`WorkflowTool`, `SkillTool`, `MonitorTool`, `ScheduleCronTool`, `RemoteTriggerTool`), worktree (`EnterWorktreeTool`, `ExitWorktreeTool`).
- `src/services/mcp/` — MCP client + server connection management. `src/services/mcpServerApproval.tsx` is the trust dialog.
- `src/coordinator/` — multi-agent coordinator (`coordinatorMode.ts`, `workerAgent.ts`); active when `COORDINATOR_MODE` is on.
- `src/components/` + `src/screens/` + `src/ink/` — Ink-based React TUI. `src/main.tsx` mounts the app; `src/screens/REPL.tsx` is the main loop. `src/native-ts/yoga-layout` is a TS port to avoid a native-addon dep.
- `src/grpc/server.ts` + `src/proto/claudio.proto` — headless gRPC service. Bidirectional streaming: text chunks, tool calls, `action_required` permission prompts.
- `src/memdir/`, `src/services/extractMemories/`, `src/services/SessionMemory/` — auto-memory: scoped per-project under `~/.claudio/projects/<dir>/memory/`, written as `.md` files indexed by `MEMORY.md`.
- `src/skills/` — user-invocable skills (`/<skill-name>`).
- `src/utils/claudioMigration.ts` + `claudioStartupMigrations.ts` — one-time migration of legacy `~/.claude/` and `~/.openclaude/` configs into `~/.claudio/`. Triggered automatically and rerunnable via `/provider migrate`. Override the config dir with `CLAUDIO_CONFIG_DIR`.

## Configuration & Credentials

- Config dir: `~/.claudio/` (override with `CLAUDIO_CONFIG_DIR=/path/to/dir`).
- `~/.claudio/settings.json` holds **plaintext API keys** for active profiles. Treat as a secret — never commit, never paste into chat.
- `~/.claudio/.credentials.json` holds OAuth tokens (Anthropic web sign-in, Codex/ChatGPT, GitHub Copilot device flow).
- Provider profiles are the source of truth; environment variables are mostly fallbacks. The historical `--provider` CLI flag is removed — users get redirected to `/provider`.
- `FIRECRAWL_API_KEY` (optional) upgrades `WebSearch`/`WebFetch` from the DuckDuckGo+raw-HTTP defaults to Firecrawl. Anthropic-native backends keep the provider-native web search behavior.
- `~/.claudio/v8cache/` (~5 MB) holds V8 bytecode cache for the bundle. `bin/claudio` enables it via `module.enableCompileCache()` and saves ~250 ms per warm launch (measured). Disable with `NODE_DISABLE_COMPILE_CACHE=1`. Invalidated on every `bun run build`, so the first run after a build is ~120 ms slower than baseline (re-populates).
- Streaming-highlight deferral is **on by default**: syntax highlighting on a fenced code block is skipped while the fence is still open during streaming, with one final pass when the fence closes. Measured ~8× lower cumulative cost in `scripts/profile/streaming-bench.ts` (~27 ms → ~3 ms for a typical TS code block); per-snapshot cost is sub-frame in both modes, so the win is CPU/battery, not perceived smoothness. Trade-off: user sees plain monospace code mid-stream and a one-shot color flash on close. Set `CLAUDIO_DEFER_HIGHLIGHT=0` to restore the always-highlight behavior.
- **Bash output filter** is **on by default**: before returning Bash tool results to the model, Claudio applies command-aware filters that strip noise (progress bars, download lines, verbose headers, test "ok" lines, etc.) while preserving errors, warnings, and actionable output. Measured savings: ~50k tokens per typical 30-min session, ~72% input-cost reduction across the top 35 commands. Toggle via `/config` → "Bash output filter", or set `bashOutputFilterEnabled: false` in `~/.claudio/settings.json` to opt out. User-defined filters: `~/.claudio/filters.json`. Architecture: `docs/tech/bash-output-filter/`.

## Tests

Bun's built-in runner. Tests are colocated as `*.test.ts(x)` next to the code they cover (~198 files); a few cross-cutting tests live in `src/__tests__/` (`bugfixes.test.ts`, `providerCounts.test.ts`, `security-hardening.test.ts`).

`test:coverage` runs at `--max-concurrency=1` (some tests touch shared global state). Coverage output is `coverage/lcov.info`; `scripts/render-coverage-heatmap.ts` builds `coverage/index.html`.

`test:provider` is the smaller targeted suite for any change touching `src/services/api/*` or context handling.

`scripts/feature-flags-source-guard.test.ts`, `scripts/measure-tool-schemas.test.ts`, `scripts/pr-intent-scan.test.ts`, and `scripts/no-telemetry-growthbook-stub.test.ts` enforce build-system invariants — run them when changing `scripts/build.ts`, the feature-flag set, or telemetry stubs.

## Pre-PR Checks

From `CONTRIBUTING.md`/`README.md`, the validation expected on a PR:

```bash
bun run build
bun run smoke
bun run test:coverage   # for shared runtime / provider changes
bun test path/to/changed.test.ts   # focused
```

If your change touches the bundle plugins, telemetry stubs, or anything network-related, also run `bun run verify:privacy`.

When changing provider behavior, exercise the actual provider/model path you touched (use `/provider doctor` from inside the REPL after `bun run dev`) and call out which provider was tested in the PR description.
