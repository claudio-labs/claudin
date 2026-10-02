# Levers: cut, replace, rewrite per method

Decided on 2026-10-02. The [README](README.md) process rewrites every inherited
module from a spec. At the pilot's rate (about 1.7 M tokens per thousand lines)
the 346 k inherited lines left would cost about 600 M tokens. This page is how
that number comes down without claiming a shortcut the law does not give.

Restyling inherited code does not clean it. Renaming, retyping and moving leave
a derived work, and the measure normalizes identifiers for that reason: an
80-line block renamed throughout still matched on 46 lines. An inherited line
leaves the tree in one of three ways, cheapest first.

1. **Cut.** The feature leaves the product.
2. **Replace** it with third-party code under a compatible license, with its
   notice kept: a maintained MIT package, or a piece of opencode (MIT).
3. **Rewrite per method.** The body of each inherited function is written again
   by someone who never saw it. The file, the signatures and our own functions
   stay.

## What each lever removes

Inherited lines, from the 2026-09-28 inventory.

| Lever | Lines |
|---|---|
| Cuts of first-party-only and dead code | ~19.7 k |
| Cuts decided on 2026-10-02 (marketplace, coordinator/swarm, PowerShell, buddy) | ~29.8 k |
| MIT packages (`yoga-layout`; `file-index` and `highlighted-code` if at parity) | ~3 k |
| opencode pieces | ~5 k |
| Left for the per-method rewrite | ~289 k |

So the cheap levers take about 17%. The core (the agent loop, the TUI,
permissions, tools, platform) has no legal shortcut. The rest of the saving is
in the process: per method there is no spec per module, because the tests are
the specification.

## The cuts

**First-party only, or unreachable:**
- `platform/bridge` and `commands/bridge` (Remote Control needs a claude.ai token)
- `platform/teleport`, `platform/remote`, `platform/remoteManagedSettings`, `platform/policyLimits`, `platform/upstreamproxy`
- `platform/server`: nothing constructs a `directConnectConfig`
- `tools/BriefTool`: `isBriefEnabled()` is always false
- `install-github-app`, `install-slack-app`, `desktop` and `stickers`
- `prompt-suggestion/speculation.ts`, which is always off
- the native installer (`install/installer.ts` and `download.ts`): `GCS_BUCKET_URL` is empty, so `claudin install` can only fail

**Decided on 2026-10-02:**
- the plugin marketplace and `/plugin`. The loader stays, and a new `pluginDirs` setting loads plugin folders through the same path as `--plugin-dir`.
- coordinator mode and the swarm. `forkedAgent`, `agentContext` and `agentId` stay.
- `PowerShellTool`
- `/buddy`

**Kept:** fast mode. It works with an Anthropic API key and runs through the
request and cache path; it goes through phase 5 with the providers.

One phase 2 unit goes with the cuts: `sessions/remote` (`useRemoteSession`,
`useSSHSession`, `useTeleportResume`).

## Replacements

**opencode (MIT, "Copyright (c) 2025 opencode").** Only pieces with little or
no Effect in them:
- `packages/opencode/src/lsp/client.ts` and `lsp/server.ts`, for `src/platform/lsp`
- `mcp/oauth-provider.ts` and `mcp/oauth-callback.ts`, for part of `src/mcp/auth`
- `plugin/openai/codex.ts`, for the Codex OAuth
- `permission/arity.ts`, for command-prefix matching in the Bash rules. The file says an LLM generated the table.

Each ported file starts with `Adapted from opencode (MIT)`, and
`THIRD_PARTY_NOTICES.md` carries opencode's license. Rebasing Claudin on opencode
was rejected. It has no equivalent for about 50 k inherited lines: the Bash
security analysis, shell hooks, headless stream-json, JSONL transcripts and the
Ink TUI. It would also mean rewriting the whole UX in Solid and Effect.

**MIT packages.**
- `src/native-ts/yoga-layout` mirrors the `yoga-layout/load` API, so the package replaces it. The gate is a render bench and the compiled binary.
- Reclassifying `src/terminal/ink` as upstream Ink code was measured and dropped. Only 262 of its 9,941 distinctive lines are in `vadimdemedes/ink`.

## Cover before touching

Any surviving file a lever edits gets tested first, and so does any file a
per-method rewrite fills in:
1. Find the lines that will change in `coverage/lcov.info` (`bun run test:coverage`).
2. If a test does not run them, add characterization tests on the public contract.
3. Prove each test with `scripts/migrations/break-probe.ts`, using a spec at `scripts/migrations/probes/levers-<group>.json`.
4. Commit the tests as `test(<slice>): pin … before …`, ahead of the change.

The check is on the lines that change, not a target for the whole file. Most
files a cut touches are wiring hubs that sit far below any target. One example
is `REPL.tsx` at 57%. Raising each of them to 70% before removing an import
would cost more than the cut itself saves. A per-method rewrite also holds the
file to the `testing.md` target, because every function in it changes.

Tests that pin behaviour being cut go with the cut, on purpose, and the commit
names them.

### Coverage of the files the cuts touch (2026-10-02)

These are the surviving files that import something being cut, with their
lcov line and function coverage. "Not loaded" means no test imports the file
at all.

| Group | Surviving files | Hubs and their coverage |
|---|---|---|
| remote | 41 | `REPL.tsx` 57%, `PromptInput.tsx` 37%, `commands.ts` 81%, `tools.ts` 92%, `settings.ts` 51%, headless `print/*` 5–8%; not loaded: `init.ts`, `cli.tsx`, `preActionHook.ts`, `Config.tsx` |
| commands | 10 | `commands.ts` 81%, `REPL.tsx` 57%, `promptSuggestion.ts` 31% |
| coordinator | 81 | `QueryEngine.ts` 7%, `AgentTool.tsx` 12%, `spawnMultiAgent.ts` 3%, `turnLoop.ts` 4%, `SendMessageTool.ts` 63%, `tools.ts` 92%; not loaded: `main.tsx`, `setup.ts`, `startupSequence.ts` |
| powershell | 11 | `permissions.ts` 40%, `PermissionRequest.tsx` 23%, `tools.ts` 92%; not loaded: `processBashCommand.tsx` |
| buddy | 7 | `REPL.tsx` 57%, `PromptInput.tsx` 37%, `messages/attachments.ts` 80% |
| marketplace | 12 | `pluginLoader.ts` 7%, `installedPluginsManager.ts` 8%, `tipRegistry.ts` 54%; not loaded: `headless/handlers/plugins.ts`, `main/commands/plugin.ts` |
| yoga | 2 | `ink/layout/yoga.ts` 91%, `ink/reconciler.ts` 78% |

## Rewriting per method

```sh
bun run scripts/migrations/rewrite/sandbox.ts bodies <unit>
```

This is a copy of HEAD with the same removals as `impl` (inherited tests, probe
specs, fingerprints, team memory), with two differences:
- The unit's files stay.
- In each file, `bodies.ts` stubs the body of every outermost function that
  holds an inherited line with `throw new Error('not rewritten: <name>')`.
  An outermost function is a declaration, a method, or a function assigned to a
  top-level name or property.

**What else it does:**
- Inherited comments outside those bodies are taken out.
- Bodies are found with oxc-parser. The outline scanner was tried first and
  failed: it ends a function at the brace of an object-typed parameter.
- For each file it reports the residue (inherited lines on a signature, which
  the contract dictates) and the inherited lines outside any function. Those
  belong to tables, types or class fields, and are rewritten whole.
- On `vcs/worktree`, the stubbed tree typechecked as is.

`land.ts` treats a `bodies` sandbox like an `impl` one. It lists every file that
still matches, and the stale probes of older specs.

**The risk that remains:** the file keeps the original's layout, meaning the
order and split of its functions. The measure cannot see structure. The legal
review before the final cut covers it.

## The first merge of main (2026-10-02)

The branch's first merge of `main` passed the baseline refresh on a lower total
(346,035), but 33 files from main gained matches. Some were moves, such as
`shims/claude/renderMessages.ts`, which took 35 lines out of `streaming.ts`.
The rest were new code with the shape of the old, such as `sonnet55.test.ts`
following `opus55.test.ts`. They join the queue like any inherited file.
`bun run provenance --files` lists them.
