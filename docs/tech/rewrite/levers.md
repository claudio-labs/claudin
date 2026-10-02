# Levers: cut, replace, rewrite per method

Decided on 2026-10-02. The [README](README.md) process rewrites every inherited
module from a spec. At the pilot's rate (about 1.7 M tokens per thousand lines)
the 346 k inherited lines left would cost about 600 M tokens. This page is how
that number comes down without claiming a shortcut the law does not give.

The levers run on the branch `rewrite/levers`, cut from `rewrite/clean-base`
and merged back by pull request one group at a time (cover and cut, yoga,
opencode). Nothing reaches `main` before the final cut.

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
| Cuts of first-party-only and dead code | ~19.7 k, plus the remote files classified below |
| MIT packages (`file-index` and `highlighted-code` if at parity; not `yoga-layout`, see below) | ~0.7 k |
| opencode pieces | ~5 k |
| Left for the per-method rewrite | ~320 k |

So the cheap levers take about 7%. The core (the agent loop, the TUI,
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

**Kept, by a reversal on 2026-10-02.** The same day these were first marked
for cutting, the user kept them. Each goes through the per-method rewrite in
its own phase:
- the plugin marketplace and `/plugin`, in phase 7;
- coordinator mode and the swarm, in phase 10;
- `PowerShellTool`, in phase 6;
- `/buddy`, in phase 9.

**Kept:** fast mode. It works with an Anthropic API key and runs through the
request and cache path; it goes through phase 5 with the providers.

One phase 2 unit goes with the cuts: the remote session hooks
(`sessions/hooks/useRemoteSession.ts`, `useSSHSession.ts`, `useTeleportResume.tsx`).

Some of the files that import the cut are remote code themselves. They were
classified on 2026-10-02 by runtime reachability, using the same rule as the
list above: code that only runs with a claude.ai token or an Anthropic-only
server counts as first-party. The bundle could not settle it, because the
build keeps every one of these modules: the gates are checked at runtime.

**Join the cut:**
- `agent/tasks/RemoteAgentTask`, `agent/ui/tasks/RemoteSessionDetailDialog.tsx`
  and `RemoteSessionProgress.tsx`, and `agent/background/remote/`. Nothing
  creates a `remote_agent` task: `registerRemoteAgentTask` has no caller, and
  `AgentTool` only accepts `isolation: 'worktree'`. `restoreRemoteAgentTasks`
  runs on every resume but returns at once, because only
  `registerRemoteAgentTask` writes the sidecars it reads, and the migration from
  `~/.claude` does not copy session directories.
- `providers/hooks/useDirectConnect.ts`. `REPL.tsx` calls it on every render with
  a `directConnectConfig` nothing passes, so it returns at once.
- `providers/transport/sessionIngress.ts`. It serves `-p --resume <url>` with
  `ENABLE_SESSION_PERSISTENCE` and `--teleport`, and both need Anthropic's
  ingress. Its one local export, `clearAllSessions`, clears that module's own
  maps, so its calls in `/clear` and compaction go with it.
- `headless/transports/ccrClient.ts`. It speaks the CCR `/worker/*` protocol,
  behind `CLAUDE_CODE_USE_CCR_V2`.
- `commands/remote-env`. Its `isEnabled` is `isClaudeAISubscriber()`.
- `main/commands/remoteControl.ts`. It registers the bridge's `rc` subcommand.
- `agent/ui/ResumeTask.tsx`. It only runs under bare `--teleport`, and reads the
  claude.ai sessions API.

**Stay, and get covered:** `headless/remoteIO.ts` and the transports other
than `ccrClient.ts`. The hidden `--sdk-url` flag runs stream-json over any
WebSocket endpoint (`ws:` or `wss:`), and nothing in that path needs Anthropic.
An `http:` or `https:` URL only works through the `CLAUDE_CODE_USE_CCR_V2`
branch, and otherwise throws `Unsupported protocol`. That branch goes with
`ccrClient.ts`.

Before deleting, check the remaining callers of the following:
- the remote-agent metadata helpers in `sessions/indexing/agents.ts`;
- `sessions/sessionIngressAuth.ts`;
- `getDirectConnectServerUrl` and `setDirectConnectServerUrl` in `bootstrap/state/cwd.ts`.

Any of them left with no caller goes too.

## Replacements

**opencode (MIT, "Copyright (c) 2025 opencode").** Only pieces with little or
no Effect in them:
- `packages/opencode/src/lsp/client.ts` and `lsp/server.ts`, for `src/platform/lsp`
- `mcp/oauth-provider.ts` and `mcp/oauth-callback.ts`, for part of `src/mcp/auth`
- `plugin/openai/codex.ts`, for the Codex OAuth
- `permission/arity.ts`, for command-prefix matching in the Bash rules. The file says an LLM generated the table.

The files each piece replaces are covered first, as the units `levers/lsp`,
`levers/mcp-auth` and `levers/codex-oauth`. Their tests pin the contract the
ported piece has to meet. Their coverage on 2026-10-02:
- `LSPClient.ts` is not loaded by any test;
- `LSPServerInstance.ts` and `LSPServerManager.ts` are at 2%, and `lsp/manager.ts` at 15%;
- the `mcp/auth` files are at 3–7%;
- `codexCredentials.ts` is at 63%, and `codexOAuthShared.ts` at 78%.

`bashPermissions/prefixes.ts` is already at 71%.

Each ported file starts with `Adapted from opencode (MIT)`, and
`THIRD_PARTY_NOTICES.md` carries opencode's license. Rebasing Claudin on opencode
was rejected. It has no equivalent for about 50 k inherited lines: the Bash
security analysis, shell hooks, headless stream-json, JSONL transcripts and the
Ink TUI. It would also mean rewriting the whole UX in Solid and Effect.

**MIT packages.**
- `src/native-ts/yoga-layout` mirrors the `yoga-layout` API, so the package (MIT, 3.2.1, WASM) can replace it.
  A spike on 2026-10-02 built Ink-shaped trees (rows with a gutter and a body of
  measured text leaves) in both engines:
  - **Layout:** identical, on 2,404, 9,604 and 36,004 values.
  - **Speed:** the package is slower, and the gap grows with the tree.

    | Messages | Full layout (port → package) | Incremental (port → package) |
    |---|---|---|
    | 100 | 0.36 → 0.99 ms | 0.17 → 0.17 ms |
    | 400 | 1.5 → 3.4 ms | 0.44 → 0.59 ms |
    | 1,500 | 4.4 → 12.8 ms | 1.0 → 2.3 ms |
  - **Import:** about 7.5 ms more, to compile the WASM.
  - **Memory:** WASM linear memory never shrinks. Upstream ported to TypeScript
    to escape that; the comment at the end of `ink/layout/yoga.ts` says so.

  **Decided on 2026-10-02: no swap.** The port goes through the per-method
  rewrite in phase 9. The package comes in as a devDependency only, as the
  tests' oracle: the same tree is laid out by both engines and the results
  compared.
- Reclassifying `src/terminal/ink` as upstream Ink code was measured and dropped. Only 262 of its 9,941 distinctive lines are in `vadimdemedes/ink`.

## Cover before touching

Any surviving file a lever edits gets tested first, and so does any file a
per-method rewrite fills in. Before the change:
1. Every function that changes is run by a test.
2. The file reaches the `testing.md` target for its slice: providers 80%,
   shared 75%, tools 70%, and 70% for a slice without a target. After
   `bun run test:coverage`, `bun run rewrite:coverage` checks it and exits 1
   while any file is below its target:
   - `--cut <path>...` checks the surviving files that import what a cut or a replacement removes;
   - `--unit <name>` checks a unit's own files;
   - a list of files checks those files.
3. Each new test is a characterization of the public contract. Prove it with
   `scripts/migrations/break-probe.ts`, using a spec at
   `scripts/migrations/probes/rewrite-levers-<group>.json`.
4. The tests are committed as `test(<slice>): pin … before …`, ahead of the change.

The groups are units in `scripts/migrations/rewrite/units/levers.json`. They
are covered in parallel like rewrite units: a `char` sandbox each
(`sandbox.ts char levers/<group>`), an agent briefed with
[briefs/cover.md](briefs/cover.md), and `land.ts` to bring the tests back.

The target is per file, not only per changed line. The user set that on
2026-10-02. It replaces an earlier rule that checked only the lines that change.

Most files a cut touches are wiring hubs far below the target. `REPL.tsx` is
at 57%, and `AgentTool.tsx` is at 12%. Covering them is not spent on the cut:
the per-method rewrite holds every file it fills in to the same target. So the
tests are the spec that rewrite needs anyway, written earlier. A file that is
itself being cut gets no tests.

Tests that pin behaviour being cut go with the cut, on purpose, and the commit
names them.

### Coverage of the files the cuts touch (2026-10-02)

These are the surviving files that import something being cut, with their lcov
line coverage, from `bun run rewrite:coverage --cut`. "Not loaded" means no test
imports the file at all.

| Group | Surviving files | Below target | Hubs and their coverage |
|---|---|---|---|
| dead code, with the remote files classified above | 49, 2 of them benches | 35 (12 not loaded) | `REPL.tsx` 57%, `PromptInput.tsx` 37%, `AgentTool.tsx` 12%, `remoteIO.ts` 2%, `settings.ts` 51%, `commands.ts` 81%, headless `print/*` 5–8%; not loaded: `cli.tsx`, `init.ts`, `preActionHook.ts`, `Config.tsx`, `clear/caches.ts` |
| yoga | 2 | 0 | `ink/layout/yoga.ts` 91%, `ink/reconciler.ts` 78% |
| opencode | — | most | `lsp/LSPServerManager.ts` 1%, `LSPServerInstance.ts` 2%, `lsp/manager.ts` 15%, `mcp/auth/*` 3–7%, `providers/oauth/client.ts` 3%; Codex OAuth 63–86% |

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
