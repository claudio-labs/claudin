# Levers: cut, replace, rewrite per method

Decided on 2026-10-02. The [README](README.md) process rewrites every inherited
module from a spec. At the pilot's rate (about 1.7 M tokens per thousand lines)
the 346 k inherited lines left would cost about 600 M tokens. This page is how
that number comes down without claiming a shortcut the law does not give.

The levers ran on the branch `rewrite/levers`, cut from `rewrite/clean-base`.
On 2026-10-03 both were merged into the single `rewrite` branch. Nothing
reaches `main` before the final cut.

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
| Cut of dead code only (see "The cuts") | ~4.9 k |
| MIT packages (`file-index` and `highlighted-code` if at parity; not `yoga-layout`, see below) | ~0.7 k |
| opencode pieces (LSP client, MCP OAuth, Codex OAuth; not the arity table) | ~2 k |
| Left for the per-method rewrite | ~338 k |

So the cheap levers take about 2%. The core (the agent loop, the TUI,
permissions, tools, platform) has no legal shortcut. The rest of the saving is
in the process: per method there is no spec per module, because the tests are
the specification.

## The cuts

**Decided on 2026-10-02: only dead code is cut.** The user's rule is that no
feature a user can reach today leaves the product. That holds even when it
needs a claude.ai login or an Anthropic server. Everything else in this
section stays, and goes through the per-method rewrite with its phase. Both
full cuts were made in worktrees (`cut/remote`, `cut/commands`), but they did
not land.

Measured in inherited lines:

| Group | Inherited lines | Fate |
|---|---|---|
| Dead: nobody can reach it | ~4.9 k | cut |
| Works only with a claude.ai login or an Anthropic server | ~16.9 k | kept |
| Reachable by any user (`/install-github-app`, `/stickers`) | ~2.0 k | kept |

**Cut, because nobody can reach it:**
- `tools/BriefTool`: `isBriefEnabled()` is always false.
- `platform/server`, `providers/hooks/useDirectConnect.ts`, and the `directConnectConfig` plumbing: nothing constructs that config.
- `agent/tasks/RemoteAgentTask` and its dialogs, `agent/background/remote/remoteSession.ts`, and the two preconditions only it calls. Nothing creates a `remote_agent` task (details below).
- `prompt-suggestion/speculation.ts`, which is always off.
- The native installer's download path (`install/download.ts`, the install half of `installer.ts`, and `claudin install`): `GCS_BUCKET_URL` is empty, so it can only fail. The parts of `installer.ts` other code calls stay.

**The original list, before 2026-10-02's decision.** Of these, only `platform/server`, `BriefTool`, `speculation.ts` and the installer's download path are dead:
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
classified on 2026-10-02 by runtime reachability, at first using the same rule
as the list above: code that only runs with a claude.ai token or an
Anthropic-only server counted as first-party. Under the dead-code-only
decision, only the remote agent task and direct-connect from the list below
are cut. The bundle could not settle it, because the build keeps every one of
these modules: the gates are checked at runtime.

**The original "join the cut" list:**
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
- `agent/ui/WorkflowMultiselectDialog.tsx`. Its only importer is
  `install-github-app`.

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
  **Ported, then not landed (2026-10-02).** The port passed every suite that
  pins `prefixes.ts`, but opencode's table settled only whether a command has a
  subcommand. About 165 of its 310 lines were the porter's own. Worse, it changed
  behaviour no suite pinned. For a command the table marks as one word
  (`rm build`), the permission dialog's editable rule became `rm:*`, where it had
  been `rm build:*`. That widens the default "always allow" on a security path,
  for 109 inherited lines. `prefixes.ts` goes through the per-method rewrite in
  phase 6, and pins for the one-word cases come first.

The files each piece replaces are covered first, as the units `levers/lsp`,
`levers/mcp-auth` and `levers/codex-oauth`. Their tests pin the contract the
ported piece has to meet. Their coverage on 2026-10-02:
- `LSPClient.ts` is not loaded by any test;
- `LSPServerInstance.ts` and `LSPServerManager.ts` are at 2%, and `lsp/manager.ts` at 15%;
- the `mcp/auth` files are at 3–7%;
- `codexCredentials.ts` is at 63%, and `codexOAuthShared.ts` at 78%.

`bashPermissions/prefixes.ts` is already at 71%.

The ports run as the units in `scripts/migrations/rewrite/units/ports.json`.
Each one gets an `impl` sandbox (`sandbox.ts impl port/<name>`), which takes
the old implementation out, and an agent briefed with
[briefs/port.md](briefs/port.md). The agent may read the opencode clone and
nothing else outside its sandbox. Its characterization suites are the
contract, and they pass unchanged except for the defects a brief marks "fix".

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

Some files fall short only because of lines the cut deletes. `plans.ts` is one:
the cover round brought it from 19% to 52%, and about 130 of its 283 lines are
the remote plan recovery. For such a file the tests still land first, and the
target is checked in the cut's own commit, on what survives. A survivor below
target after the cut blocks the commit.

Two measurement traps, both found in the cover round:
- **Feature flags.** `bun test` runs every `feature()` as false, and 32 flags
  are true in the build. A line behind one of those flags runs in production
  but in no test. `interactiveHandler.ts` stops at 46% because of it.
- **Query-string imports.** About 30 suites import a module under a
  cache-busting query string (`./plans.js?t=…`) to get a fresh copy. Bun's lcov
  keeps one record per file, so in a run that loads several copies the number
  depends on which copy it kept. `plans.ts` reads 19% whenever `plans.test.ts`
  is in the run, whatever else covers it.

  Until those suites change, a full `bun run test:coverage` undercounts those
  modules. A unit is measured by a run limited to its characterization suites.

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

**After the cover round (2026-10-02).** All eleven units landed:
- 1,232 characterization tests;
- 267 break-probes, re-run in the checkout before each landing. The ports later replaced the probes of the code they removed.

Of the 48 surviving files the cut touches, 42 reach their target. The six left:
- `plans.ts`, `settingsControlHandlers.ts`, `defaultAction/resume.ts` and `dialogLaunchers.tsx` fall short only by lines the cut deletes. The cut's commit checks them.
- `cli.tsx` and `interactiveHandler.ts` are exceptions. Their reasons are in [levers-findings.md](levers-findings.md), which also lists every defect the round pinned.

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

**What a brief must say about the lines outside the bodies.**
- Exported types and props types are the contract, so keep them.
- Everything else is still inherited: module constants, private types,
  tables, and a class's private fields. Rewrite it in the agent's own form,
  with the same meaning.

`sessions/persistence` was briefed to keep every declaration outside the
bodies. About 115 lines of `Project`'s old private state survived as
residue as a result.

**Land a characterization suite against the current tree, not its base.**
A suite characterized before a neighbouring unit was rewritten can catch that
rewrite's regressions. That happened when `sessions/ui` landed: it caught the
branch a `sessions/liteMetadata` full load had dropped. Run the full suite
after every landing.

`land.ts` treats a `bodies` sandbox like an `impl` one. It lists every file that
still matches, and the stale probes of older specs.

**The risk that remains:** the file keeps the original's layout, meaning the
order and split of its functions. The measure cannot see structure. The legal
review before the final cut covers it.

### What the first unit measured (2026-10-03)

`vcs/worktree` was the first per-method unit: 8 files, 27 stubbed functions,
1,104 inherited lines. It was characterized on 2026-09-28.
- **Implementation:** one agent, 31 minutes, 83 tool calls and about 260 k
  tokens. About 12 of those minutes went to its break-probe run.
- **Result:** 41 lines of reviewed residue (see the unit's spec).
- **Rate:** about 0.24 M tokens per thousand inherited lines removed, for the
  implementation alone. The pilot's 1.7 M also included characterization. The
  cover units of 2026-10-02 spent 0.17 to 0.37 M tokens each, so a unit that
  still needs its tests costs roughly twice the implementation figure.
- **Remaining:** at about 0.5 M per thousand lines, the ~335 k lines come to
  about 170 M tokens instead of 600 M.

## The first merge of main (2026-10-02)

The branch's first merge of `main` passed the baseline refresh on a lower total
(346,035), but 33 files from main gained matches. Some were moves, such as
`shims/claude/renderMessages.ts`, which took 35 lines out of `streaming.ts`.
The rest were new code with the shape of the old, such as `sonnet55.test.ts`
following `opus55.test.ts`. They join the queue like any inherited file.
`bun run provenance --files` lists them.
