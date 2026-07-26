# AGENTS.md

Orientation for agents working in this repo. Deep, path-scoped conventions live
in `.claudin/rules/` (auto-loaded when you touch matching files) and repeatable
procedures live in `.claudin/skills/` — this file stays high-level and points at
them rather than repeating them.

## Coding rules & skills

Rules in `.claudin/rules/` (auto-loaded into context by path):

- [typescript-patterns.md](.claudin/rules/typescript-patterns.md) — TS idioms, error handling, zod schemas, provider abstraction, privacy rules, `feature()`/`--compile` coding gotchas.
- [build-system.md](.claudin/rules/build-system.md) — `feature()` preprocessing, `MACRO.*`, stub modules, telemetry stubs, feature-flag catalog (scoped to `scripts/build.ts`).
- [testing.md](.claudin/rules/testing.md) — Bun runner, snapshots, provider tests, cross-file mock leaks, known full-suite flakes, the Pre-PR checklist.
- [ink-tui.md](.claudin/rules/ink-tui.md) — forked Ink renderer constraints: grid model, inline images, vacated-cell ghosts, ScrollBox, committed React-Compiler output (scoped to the TUI dirs).
- [cache.md](.claudin/rules/cache.md) — prompt-cache clip-frontier invariant, defer-cache-marker, tool-result cache cwd invalidation, TTL tiers.
- [agent-safety.md](.claudin/rules/agent-safety.md) — sub-agent/worktree hazards: no git mutation in review agents, worktree stale-base/write-leak, empirical audit method (always-on).
- [search-strategy.md](.claudin/rules/search-strategy.md) — module map + common Grep/Glob queries (start here to navigate the codebase).

Skills in `.claudin/skills/` (invoke with `/<name>`):

- [/pre-pr](.claudin/skills/pre-pr/SKILL.md) — run the pre-PR validation gate (build, smoke, typecheck, focused tests, conditional `test:provider`/`verify:privacy`).
- [/add-provider-preset](.claudin/skills/add-provider-preset/SKILL.md) — add a `/provider` preset (OpenAI-compatible API-key recipe or OAuth web-login variant).

## Project Overview

Claudin is an open-source coding-agent CLI forked from the Claude Code codebase, retargeted to work across many model providers (Anthropic, OpenAI-compatible, Gemini, Mistral, GitHub Copilot, Codex OAuth, xAI/Grok, Ollama, Bedrock, Vertex, Foundry, etc.). The runtime is the same agent loop (tools, MCP, slash commands, streaming, sub-agents) but provider selection and credentials are managed entirely from inside the REPL via `/provider`, with profiles persisted under `~/.claudin/settings.json`.

The project is **not affiliated with Anthropic**. Telemetry/phone-home paths from upstream are replaced with no-op stubs at build time (see `scripts/no-telemetry-plugin.ts`) and `bun run verify:privacy` enforces this on the bundle.

## Repo Etiquette

Use Issues for confirmed bugs and actionable feature work; use Discussions for setup help and ideas. Open an issue first for larger changes before implementing. See `CONTRIBUTING.md` for the full contribution guidelines (PR content expectations, code style, security reports via `SECURITY.md`).

## Common Commands

```bash
bun install                 # install deps (uses bun.lock)
bun run build               # bundle src/entrypoints/cli.tsx → dist/cli.mjs
bun run dev                 # build + node dist/cli.mjs
bun run smoke               # build + --version sanity check
bun run typecheck           # tsc --noEmit
bun test                    # full Bun test runner suite (~198 test files)
bun test path/to/file.test.ts  # focused single-file test
bun run verify:privacy      # scan dist/cli.mjs for banned phone-home patterns
```

Those are the *human* invocations. An agent should run tests through the **RunTests tool**, which wraps the same command and answers failures-first; BashTool refuses a bare test command once and points there (see the toggle table below).

More test targets (`test:provider`, `test:coverage`, invariant tests) are documented in [testing.md](.claudin/rules/testing.md). After install or local build, the launcher is `bin/claudin` — it requires `dist/cli.mjs` to exist. There is no dev runner that bypasses the bundle, so **always `bun run build` after a source change**.

### `claudin` vs `claudindev` (dev convention)

To keep the published release usable while iterating on unreleased features, contributors should use two binaries on `$PATH`:

- **`claudin`** → globally installed npm package (`@claudiolabs/claudin`) — stable release, only updated via `bun install -g @claudiolabs/claudin`.
- **`claudindev`** → symlink to `<repo>/bin/claudin`, created by `bun run link:dev` (into `~/.bun/bin` or `~/.local/bin`) — always runs the latest local `bun run build` output (`dist/cli.mjs`) from your checkout.

Implication: if a user reports a just-built feature "doesn't show up", check which binary they launched. Source-tree changes only take effect under `claudindev` (after `bun run build`); `claudin` keeps the pinned release version regardless of repo state.

## Architecture

Single entrypoint, single-file bundle: `src/entrypoints/cli.tsx` → `dist/cli.mjs`, launched by `bin/claudin`. The [search-strategy.md](.claudin/rules/search-strategy.md) rule has the full navigable module map; the high-level shape:

- `src/entrypoints/cli.tsx` — process entrypoint. Fast-paths `--version`, then dynamically imports the rest (cold paths don't pay full module-eval cost).
- `src/QueryEngine.ts` + `src/query.ts` — the agent loop: model drive, tool dispatch, streaming SDK messages (`src/entrypoints/agentSdkTypes.ts`), usage, compaction/permission/coordination.
- `src/Tool.ts` — central tool type system (`Tool`, `ToolUseContext`, `buildTool`). Tools live under `src/tools/<Name>/` (zod schema + prompt + execute); the registry is built dynamically per context.
- `src/services/api/` — provider abstraction. `client.ts` builds the right SDK from `activeProvider.ts`; `openaiShim.ts` (~2.2k lines) translates to OpenAI Chat Completions; `codexShim.ts` is ChatGPT OAuth; `providerConfig.ts` holds presets/profile schema/OAuth; `withRetry.ts`/`errors.ts` do retry + error classification.
- `src/commands/` — slash commands (`/provider`, `/review`, `/plan`, `/resume`, `/mcp`, `/skills`, …), discovered via `src/commands.ts`.
- `src/tools/` — built-in tools: file IO, search (`GrepTool`/`GlobTool`), shell (`BashTool`), agents/tasks, MCP, planning, web, workflow, worktree.
- `src/services/mcp/` — MCP client + server connection management; `src/services/mcpServerApproval.tsx` is the trust dialog.
- `src/coordinator/` — multi-agent coordinator (active when `COORDINATOR_MODE` is on).
- `src/components/` + `src/screens/` + `src/ink/` — Ink React TUI; `src/main.tsx` mounts, `src/screens/REPL.tsx` is the main loop; `src/native-ts/yoga-layout` avoids a native-addon dep.
- `src/memdir/`, `src/services/extractMemories/`, `src/services/SessionMemory/` — auto-memory: for git projects defaults to project-local `<repo>/.claudin/memory/`, `.md` files indexed by `MEMORY.md`. `memory/team/` is meant to be git-tracked (carve it out of `.gitignore`, which blanket-ignores `.claudin/`); private `memory/*.md` stays ignored.
- `src/skills/` — skills (`/<skill-name>`); bundled ones in `src/skills/bundled/`, `/create` authors new skills/rules/agents in the `.claudin/` structure.
- `src/utils/claudinMigration.ts` + `claudinStartupMigrations.ts` — one-time migration of legacy `~/.claude/`/`~/.openclaude/` into `~/.claudin/`; rerunnable via `/provider migrate`; override the config dir with `CLAUDIN_CONFIG_DIR`.

Note: an earlier headless gRPC service (`src/grpc/`, `src/proto/claudin.proto`, `dev:grpc*` scripts) was removed (#22) — it no longer exists despite lingering mentions in older docs.

## Configuration & Credentials

- **Config dir**: `~/.claudin/` (override with `CLAUDIN_CONFIG_DIR=/path/to/dir`).
- **Secrets** — never commit, never paste into chat: `~/.claudin/settings.json` (plaintext API keys for active profiles) and `~/.claudin/.credentials.json` (OAuth tokens — Anthropic web sign-in, Codex/ChatGPT, Copilot device flow).
- Provider profiles are the source of truth; env vars are mostly fallbacks. The historical `--provider` CLI flag is removed — users get redirected to `/provider`.
- `FIRECRAWL_API_KEY` (optional) upgrades `WebSearch`/`WebFetch` from the DuckDuckGo+raw-HTTP defaults to Firecrawl.

Several runtime behaviors are **on by default** with their own docs and toggles:

| Behavior | Toggle / override | Docs |
|----------|-------------------|------|
| Bash output filter | `/config` → "Bash output filter"; `bashOutputFilterEnabled: false` | `docs/tech/bash-output-filter/` |
| Cache policy (clip-frontier + per-provider profile) | `CLAUDIN_CLIP_FRONTIER=0`, `CLAUDIN_CACHE_PROFILE=aggressive\|retain` | `src/services/cache/README.md`, `docs/tech/cache/` |
| Auto-background agents / fork-subagent default | `/config` → "Auto-background agents"; `autoBackgroundAgentsEnabled: false` | AGENTS memory + `scripts/profile/agent-bg-token-bench.ts` |
| Streaming-highlight deferral | `CLAUDIN_DEFER_HIGHLIGHT=0` | `scripts/profile/streaming-bench.ts` |
| V8 bytecode cache (`~/.claudin/v8cache/`) | `NODE_DISABLE_COMPILE_CACHE=1` | invalidated on every `bun run build` |
| Read clip-pin stand-down (re-sent Read body survives the clip paths; if it is clipped anyway the range serves a **sticky** outline, budgeted by `STICKY_REPLAY_BUDGET` so it re-arms with a real body instead of refusing forever). It bounds the **body rate and the permanent refusal**, not the cycle: the counters live on the readFileState entry and both reset per cycle, so a file that keeps getting clipped settles at two bodies every six-to-seven reads rather than stopping. **Reach** — only an entry a prior full Read wrote enters the stand-down (`offset` set, no `isPartialView`), so the auto-outline pivot's entries never do; in practice that means explicit-range reads, non-code files and code files under the pivot's ≥250-line / 10k-char threshold | `CLAUDIN_DISABLE_READ_CLIP_PIN=1` — legacy alias `CLAUDIN_DISABLE_READ_RERUN_BREAKER=1` still honored. Scope: the **pin** only. The dedup stand-down, Read's tool-result-cache bypass, the `STAND_DOWN_STRIKES` bound and the sticky marker are correctness paths and stay on — the killswitch must not hand back an unbounded re-send loop. Separately, the GrowthBook flag `tengu_read_dedup_killswitch` disables the whole dedup lane **including** the sticky marker, so it *can* restore unbounded re-sends; that is the one to reach for only in an emergency | `src/tools/FileReadTool/FileReadTool.ts`, `src/services/compact/stableStubState.ts` |
| Repeated-failure hint (a `<system-reminder>` on an errored `tool_result` after 3 identical failures — applies to **every** tool) | `/config` → "Repeated-failure hint"; `repeatedFailureHintEnabled: false` | `src/services/tools/toolExecution.ts`, `src/services/extractMemories/loopDetector.ts` |
| Bash → RunTests redirect (a bare test command in Bash is refused **once** with a pointer to `RunTests`; re-sending the identical command runs it, which is the only way to get raw runner output). Narrow by design: single command only, must *start* with the runner, no quotes, and raw-output/non-run flags (`-s`, `--nocapture`, `--watch`, `--reporter`, `--no-run`, …) opt out | `CLAUDIN_DISABLE_RUNTESTS_REDIRECT=1`; also skipped when `RunTests` is absent from the agent's toolset or `run_in_background` is set | `src/tools/RunTestsTool/redirect.ts` |

## Build & Tests

- **Build system** — `scripts/build.ts` preprocesses source (`feature()` folding), inlines `MACRO.*`, and stubs missing modules. The mechanics and rules are in [build-system.md](.claudin/rules/build-system.md). The one that bites everywhere: **`bun run build` after every source change** (the launcher runs the bundle, not source).
- **Tests** — Bun's runner, colocated `*.test.ts(x)`; targets, mocking policy, coverage, and the Pre-PR checklist are in [testing.md](.claudin/rules/testing.md). Run [/pre-pr](.claudin/skills/pre-pr/SKILL.md) before opening a PR. When changing provider behavior, exercise the actual provider/model path (`/provider doctor` after `bun run dev`) and name the tested provider in the PR description.
