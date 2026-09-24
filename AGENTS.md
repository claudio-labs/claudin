# AGENTS.md

Orientation for agents working in this repo

## Project Overview

Claudin is an open-source coding-agent CLI, (Anthropic, OpenAI-compatible, Gemini, Mistral, GitHub Copilot, Codex OAuth, xAI/Grok, Ollama, Bedrock, Vertex, Foundry, etc.). The runtime is that same agent loop (tools, MCP, slash commands, streaming, sub-agents)

## Repo Etiquette

Use Issues for confirmed bugs and actionable feature work; use Discussions for setup help and ideas. Open an issue first for larger changes before implementing. See `CONTRIBUTING.md` for the full contribution guidelines (PR content expectations, code style, security reports via `SECURITY.md`).

## Common Commands

```bash
bun install                 # install deps (uses bun.lock)
bun run build               # bundle src/platform/entrypoints/cli.tsx → dist/cli.mjs
bun run dev                 # build + node dist/cli.mjs
bun run smoke               # build + --version sanity check
bun run typecheck           # tsc --noEmit
bun test                    # full Bun test runner suite (827 test files)
bun test path/to/file.test.ts  # focused single-file test
bun run verify:privacy      # scan dist/cli.mjs for banned phone-home patterns
```

More test targets (`test:provider`, `test:coverage`, invariant tests) are documented in [testing.md](.claudin/rules/testing.md). After install or local build, the launcher is `bin/claudin` — it requires `dist/cli.mjs` to exist. There is no dev runner that bypasses the bundle, so **always `bun run build` after a source change**.

Every script behind those commands lives in `scripts/`, one directory per purpose — `build/ release/ verify/ codegen/ bench/ migrations/`. [scripts/README.md](scripts/README.md) is the map, and it carries the two traps that bite anything written there: derive the repo root from `scripts/repoRoot.ts` rather than counting `..`, and remember that a path assembled from string segments is invisible to tsc, to the build's import pre-scan and to every rename tool.

If a just-built feature "doesn't show up", check which binary was launched: contributors keep the released `claudin` and a `claudindev` symlink to this checkout side by side, and only the second one runs what you just built. `CONTRIBUTING.md` sets that up under "Local Setup".

## Architecture — Screaming Architecture + Vertical Slice

Single entrypoint, single-file bundle: `src/platform/entrypoints/cli.tsx` → `dist/cli.mjs`, launched by `bin/claudin`. The [search-strategy.md](.claudin/rules/search-strategy.md) rule has the full navigable module map.

The two patterns this tree commits to, by name: **Screaming Architecture** — the top level of `src/` names the *domain* (`providers/ tools/ permissions/ sessions/ skills/`), never the framework or the technical layer — and **Vertical Slice Architecture** — each of those owns its whole stack (logic, UI, hooks, types, constants, tests) instead of one feature being smeared across layer directories. New work follows both. The rest of this section is what they mean concretely here, and `src/__tests__/moduleBoundaries.test.ts` is the only thing enforcing them.

Every directory under `src/` is a **feature slice** that owns its own logic, UI and tests: `agent/` (the loop, its prompts, its REPL, its tasks), `providers/`, `tools/`, `commands/`, `permissions/`, `mcp/`, `containers/`, `sessions/`, `memory/`, `vcs/`, `plugins/`, `skills/`, plus `platform/` (the host — process, config, settings, OS integration) and `terminal/` (the TUI shell). `shared/` is for primitives with no owner, grouped into `data/` `fs/` `proc/` `text/` `constants/` `types/`; a subsystem appearing there is a bug. Three more directories exist and are **not** slices, so don't file features in them: `__tests__/` (repo-wide invariants only — everything else is colocated), `stubs/` and `native-ts/`.

That replaced seven catch-all directories — `components/`, `services/`, `utils/`, `screens/`, `constants/`, `hooks/`, `types/` — the layer names Screaming Architecture rules out, which had grown by accretion because "where does this go?" had no answer, and which once forced `/diff` to reach across eleven top-level dirs. `scripts/migrations/reorg/manifest.ts` records every destination and why, and `git log --follow` works across the move (each group was committed as pure renames).

### Where a new file goes

Ask which slice **owns** the behavior, and put it there — including its UI (`<slice>/ui/`), its React hooks (`<slice>/hooks/`), its tests (colocated `*.test.ts(x)`) and its test harnesses (`<slice>/__testutils__/`). Reach for `src/shared/` only for a primitive with genuinely no owner; if the thing you are adding has a subsystem's name on it, it belongs to that subsystem. When no slice fits, the answer is a new slice, never a bucket.

Cross-slice imports use the **`src/…` alias** (`tsconfig.json` maps `src/*` → `./src/*`), not a `../` chain: a relative one compiles and bundles fine while encoding the distance between two slices, so the next move of *either* file silently re-derives the chain. The tree is 17k aliased imports against 6 relative `from` specifiers. The **exception is load-bearing**: an import of a module this fork never received (a `.d.ts` with no `.ts`/`.tsx` beside it) must stay relative, because `scripts/build/build.ts` only stubs a missing module when the specifier starts with `./` or `../` — aliasing one trades a green build for a hard resolver failure. The six in `src/` are that case, or fake source inside a test fixture; see [build-system.md](.claudin/rules/build-system.md).

`src/__tests__/moduleBoundaries.test.ts` is what keeps this true, and it is the whole enforcement: it fails if a retired bucket comes back, if the slices that absorbed them stop being where the tree says, or if a cross-slice relative import appears that *does* resolve to a real module (the missing-module case is resolved, not pattern-matched, so the exception survives). When it fails, move the file or alias the import — never widen the list.

### Finding your way in

What every directory holds — with file counts and a cross-ref to the rule that owns each subsystem — is the Module Map in [search-strategy.md](.claudin/rules/search-strategy.md). Read it before a broad search; it is scoped to `src/**`, so it loads as soon as you open a source file.


## Build & Tests

- **Build system** — `scripts/build/build.ts` preprocesses source (`feature()` folding), inlines `MACRO.*`, and stubs missing modules. The mechanics and rules are in [build-system.md](.claudin/rules/build-system.md). The one that bites everywhere: **`bun run build` after every source change** (the launcher runs the bundle, not source).
- **Tests** — Bun's runner, colocated `*.test.ts(x)`; targets, mocking policy, coverage, and the Pre-PR checklist are in [testing.md](.claudin/rules/testing.md). Run [/pre-pr](.claudin/skills/pre-pr/SKILL.md) before opening a PR. When changing provider behavior, exercise the actual provider/model path (`/provider doctor` after `bun run dev`) and name the tested provider in the PR description.
- **Typecheck** — `bun run typecheck` (`tsc --noEmit`) **reaches zero**, and `typecheck-baseline.json` is `count: 0`. CI still runs the `bun run typecheck:ci` ratchet (`scripts/verify/typecheck-ci.ts`), which fails a PR only for errors it **adds** against the committed baseline by a line-independent fingerprint — against an empty baseline that is simply "no new errors". Refresh it with `bun run typecheck:baseline` when a change legitimately moves existing errors; fixing errors never fails the run.

  Reaching zero left two counter-intuitive facts behind, and old notes contradict both: the `.tsx` checked in as React-Compiler output **are** hand-fixable ([ink-tui.md](.claudin/rules/ink-tui.md)), and every export in the fork's `.d.ts` files is `any` **on purpose** ([build-system.md](.claudin/rules/build-system.md)).
