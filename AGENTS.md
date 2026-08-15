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
bun run build               # bundle src/platform/entrypoints/cli.tsx → dist/cli.mjs
bun run dev                 # build + node dist/cli.mjs
bun run smoke               # build + --version sanity check
bun run typecheck           # tsc --noEmit
bun test                    # full Bun test runner suite (~605 test files)
bun test path/to/file.test.ts  # focused single-file test
bun run verify:privacy      # scan dist/cli.mjs for banned phone-home patterns
```

Those are the *human* invocations. An agent should run tests through the **RunTests tool**, which wraps the same command and answers failures-first; BashTool refuses a bare test command once and points there.

More test targets (`test:provider`, `test:coverage`, invariant tests) are documented in [testing.md](.claudin/rules/testing.md). After install or local build, the launcher is `bin/claudin` — it requires `dist/cli.mjs` to exist. There is no dev runner that bypasses the bundle, so **always `bun run build` after a source change**.

If a just-built feature "doesn't show up", check which binary was launched: contributors keep the released `claudin` and a `claudindev` symlink to this checkout side by side, and only the second one runs what you just built. `CONTRIBUTING.md` sets that up under "Local Setup".

## Architecture — Screaming Architecture + Vertical Slice

Single entrypoint, single-file bundle: `src/platform/entrypoints/cli.tsx` → `dist/cli.mjs`, launched by `bin/claudin`. The [search-strategy.md](.claudin/rules/search-strategy.md) rule has the full navigable module map.

The two patterns this tree commits to, by name: **Screaming Architecture** — the top level of `src/` names the *domain* (`providers/ tools/ permissions/ sessions/ skills/`), never the framework or the technical layer — and **Vertical Slice Architecture** — each of those owns its whole stack (logic, UI, hooks, types, constants, tests) instead of one feature being smeared across layer directories. New work follows both. The rest of this section is what they mean concretely here, and `src/__tests__/moduleBoundaries.test.ts` is the only thing enforcing them.

Every directory under `src/` is a **feature slice** that owns its own logic, UI and tests: `agent/` (the loop, its prompts, its REPL, its tasks), `providers/`, `tools/`, `commands/`, `permissions/`, `mcp/`, `sessions/`, `memory/`, `vcs/`, `plugins/`, `skills/`, plus `platform/` (the host — process, config, settings, OS integration) and `terminal/` (the TUI shell). `shared/` is for primitives with no owner, grouped into `data/` `fs/` `proc/` `text/` `constants/` `types/`; a subsystem appearing there is a bug. Four more directories exist and are **not** slices, so don't file features in them: `__tests__/` (repo-wide invariants only — everything else is colocated), `stubs/`, `vendor/` and `native-ts/`.

That replaced seven catch-all directories — `components/`, `services/`, `utils/`, `screens/`, `constants/`, `hooks/`, `types/` — the layer names Screaming Architecture rules out, which had grown by accretion because "where does this go?" had no answer, and which once forced `/diff` to reach across eleven top-level dirs. `scripts/reorg/manifest.ts` records every destination and why, and `git log --follow` works across the move (each group was committed as pure renames).

### Where a new file goes

Ask which slice **owns** the behavior, and put it there — including its UI (`<slice>/ui/`), its React hooks (`<slice>/hooks/`), its tests (colocated `*.test.ts(x)`) and its test harnesses (`<slice>/__testutils__/`). Reach for `src/shared/` only for a primitive with genuinely no owner; if the thing you are adding has a subsystem's name on it, it belongs to that subsystem. When no slice fits, the answer is a new slice, never a bucket.

Cross-slice imports use the **`src/…` alias** (`tsconfig.json` maps `src/*` → `./src/*`), not a `../` chain: a relative one compiles and bundles fine while encoding the distance between two slices, so the next move of *either* file silently re-derives the chain. The tree is 17k aliased imports against 8 relative `from` specifiers. The **exception is load-bearing**: an import of a module this fork never received (a `.d.ts` with no `.ts`/`.tsx` beside it) must stay relative, because `scripts/build.ts` only stubs a missing module when the specifier starts with `./` or `../` — aliasing one trades a green build for a hard resolver failure. All 109 cross-slice relative specifiers left in `src/` are that case; see [build-system.md](.claudin/rules/build-system.md).

`src/__tests__/moduleBoundaries.test.ts` is what keeps this true, and it is the whole enforcement: it fails if a retired bucket comes back, if the slices that absorbed them stop being where the tree says, or if a cross-slice relative import appears that *does* resolve to a real module (the missing-module case is resolved, not pattern-matched, so the exception survives). When it fails, move the file or alias the import — never widen the list.

### Finding your way in

Most code lives in four slices — `platform/` (the host), `tools/`, `agent/` and `terminal/` — so Grep inside one rather than across `src/`. Two names repeat with different owners: the Claude Code lifecycle hooks (`PreToolUse`, …) are `src/platform/lifecycleHooks/` while React hooks sit in each slice's own `hooks/`; and `src/agent/context/` is token accounting, `src/terminal/contexts/` is the React providers, `src/agent/context.ts` (singular) is the memoized system-prompt blocks.

What every directory holds — with file counts and a cross-ref to the rule that owns each subsystem — is the Module Map in [search-strategy.md](.claudin/rules/search-strategy.md). Read it before a broad search; it is scoped to `src/**`, so it loads as soon as you open a source file.

## Configuration & Credentials

- **Config dir**: `~/.claudin/` (override with `CLAUDIN_CONFIG_DIR=/path/to/dir`).
- **Secrets** — never commit, never paste into chat: `~/.claudin/settings.json` (plaintext API keys for active profiles) and `~/.claudin/.credentials.json` (OAuth tokens — Anthropic web sign-in, Codex/ChatGPT, Copilot device flow).
- Provider profiles are the source of truth; env vars are mostly fallbacks. The historical `--provider` CLI flag is removed — users get redirected to `/provider`.
- `FIRECRAWL_API_KEY` (optional) upgrades `WebSearch`/`WebFetch` from the DuckDuckGo+raw-HTTP defaults to Firecrawl.

Claudin ships several behaviors that are **on by default** — the Bash output filter, the cache policy, the Read clip-pin, the Bash→RunTests and Bash→Typecheck redirects, the repeated-failure hint, fork-by-default sub-agents. Each is documented at the top of the module that implements it, where its `CLAUDIN_*` killswitch is named; `/config` is the surface users get. They are deliberately not tabulated here: every agent harness that opens this repo reads this file, and a Claudin-only behavior described here reads as an instruction the others cannot honor.

## Build & Tests

- **Build system** — `scripts/build.ts` preprocesses source (`feature()` folding), inlines `MACRO.*`, and stubs missing modules. The mechanics and rules are in [build-system.md](.claudin/rules/build-system.md). The one that bites everywhere: **`bun run build` after every source change** (the launcher runs the bundle, not source).
- **Tests** — Bun's runner, colocated `*.test.ts(x)`; targets, mocking policy, coverage, and the Pre-PR checklist are in [testing.md](.claudin/rules/testing.md). Run [/pre-pr](.claudin/skills/pre-pr/SKILL.md) before opening a PR. When changing provider behavior, exercise the actual provider/model path (`/provider doctor` after `bun run dev`) and name the tested provider in the PR description.
- **Typecheck** — `bun run typecheck` (`tsc --noEmit`) **reaches zero**, and `typecheck-baseline.json` is `count: 0`. CI still runs the `bun run typecheck:ci` ratchet (`scripts/typecheck-ci.ts`), which fails a PR only for errors it **adds** against the committed baseline by a line-independent fingerprint — against an empty baseline that is simply "no new errors". Refresh it with `bun run typecheck:baseline` when a change legitimately moves existing errors; fixing errors never fails the run.

  Reaching zero left two counter-intuitive facts behind, and old notes contradict both: the `.tsx` checked in as React-Compiler output **are** hand-fixable ([ink-tui.md](.claudin/rules/ink-tui.md)), and every export in the fork's `.d.ts` files is `any` **on purpose** ([build-system.md](.claudin/rules/build-system.md)).
