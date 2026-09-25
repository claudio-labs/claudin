---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---

## Module Map

Approximate `.ts(x)` counts in `(N)`, measured 2026-09-21. Each top-level dir is
a **feature slice** that owns its own logic, UI and tests — a slice's Ink
components sit in its `ui/`, not in a shared component dump. The four big ones
(`platform`, `tools`, `agent`, `terminal`) are where most code lives. Cross-refs
point to the rule that owns that subsystem.

```
src/
├── agent/ (552)                 ← the agent loop and everything that renders it
│   ├── QueryEngine.ts           ← model drive, tool dispatch, streaming, compaction
│   ├── query.ts + query/ (8)    ← query helpers, SDKMessage types; config.ts, deps.ts, tokenBudget.ts
│   ├── context.ts               ← getSystemContext/getUserContext: the memoized system-prompt
│   │                              context blocks (git status, dir structure)
│   ├── context/ (12)            ← token accounting + context-window math. Three things carry
│   │                              this name: agent/context.ts (prompt blocks), agent/context/
│   │                              (accounting), terminal/contexts/ (React providers)
│   ├── prompts/ (26)            ← prompts.ts (the system prompt), familyAddendums/, steeringToggles
│   ├── repl/ (38)               ← REPL.tsx (main loop), controllers/, ui/ (8), replLauncher
│   ├── ui/ (166)                ← the loop's Ink components: messages/, tasks/, agents/ (→ ink-tui.md)
│   ├── tools/ (45)              ← toolExecution, toolResultCache (→ cache.md); toolResultSummarizer.ts
│   │                              is a BARREL over toolResultSummarizer/ — one module per strategy
│   │                              (bash, grep, webFetch, glob, headTail, structural) plus types,
│   │                              thresholds, markers, contentShape, and decisionRecord, which is
│   │                              the sole owner of the lastDecision mutable
│   ├── tasks/ (37)              ← task runtime backends: LocalAgentTask, MonitorMcpTask, DreamTask …
│   ├── coordinator/ (40)        ← multi-agent coordinator + swarm backends (COORDINATOR_MODE)
│   ├── compact/ (34)            ← compaction: autoCompact, microCompact; stableStubState.ts is a
│   │                              BARREL over stableStubState/ (clippedIdRegistry owns the
│   │                              per-key state, pinRegistry, clipStubText, clipFrontier).
│   │                              compact.ts is NOT a barrel: it keeps compactConversation and
│   │                              partialCompactConversation over postCompactAttachments.ts and
│   │                              messagePreparation.ts
│   ├── cache/ (6)               ← prompt-cache policy + profiles (→ cache.md)
│   ├── messages/ attachments/   ← message normalization, attachment rendering
│   ├── hooks/ (18)              ← React hooks for the loop (useCancelRequest, useTasksV2 …)
│   ├── plans/ goal/ autoFix/           ← planning + self-correction
│   └── scratchpad.ts            ← the per-session scratchpad dir (permissions only consumes it)
├── providers/ (296)             ← provider abstraction (start here for provider issues)
│   ├── presets/ (20)            ← activeProvider.ts (resolver), providerConfig.ts (presets, profile
│   │                              schema), providerProfiles, discovery, validation
│   ├── shims/ (62)              ← openaiShim.ts is a BARREL; the Anthropic → OpenAI Chat
│   │                              Completions renderer is openaiShim/ (~4.9k lines), which also
│   │                              holds the ten end-to-end suites that drive the barrel with a
│   │                              stubbed fetch over __testutils__/shimHarness.ts. Also
│   │                              codexShim.ts (ChatGPT OAuth), claude/ (native renderer → cache.md)
│   ├── transport/ (36)          ← client.ts (SDK builder), withRetry.ts, errors.ts, proxy, h2Fallback
│   ├── oauth/ (37)              ← per-provider OAuth + credential stores (codex, kimi, xai, gemini …)
│   ├── model/ (46)              ← model.ts (getMainLoopModel, getSmallFastModel),
│   │                              providers.ts (getAPIProvider), modelOptions, catalogs.
│   │                              getPrimaryModel is presets/providerModels.ts and
│   │                              getContextWindowForModel is agent/context/context.ts
│   ├── effort/ (7)              ← reasoning-effort levels + cycling (project-scoped)
│   ├── usage/ (15)              ← cost, billing, quota, per-provider usage endpoints
│   ├── cache/ (10)              ← cache METRICS: hit stats, break detection. The cache policy
│   │                              itself is agent/cache/ (→ cache.md)
│   ├── ui/ (38)                 ← ProviderManager, ModelPicker, EffortPicker, OAuth flows
│   └── (adding a preset? use the /add-provider-preset skill)
├── tools/ (682)                 ← built-in tools, one dir per tool; entry is <Name>Tool.ts(x)
│   ├── Tool.ts                  ← central type system: Tool, Tools, ToolUseContext, buildTool()
│   ├── tools.ts                 ← dynamic registry (sandbox/plan/coordinator/MCP-aware)
│   ├── BashTool/                ← shell execution, permissions, sandbox
│   ├── FileReadTool/ FileEditTool/ FileWriteTool/ NotebookEditTool/  ← file IO
│   ├── GrepTool/ GlobTool/      ← ripgrep + glob wrappers
│   ├── GitTool/                 ← git + gh, batched; permissions delegate to BashTool's
│   ├── AgentTool/               ← sub-agent spawning (built-in agents in built-in/)
│   ├── TaskCreateTool/ …        ← task tool surface (runtime backends are src/agent/tasks/)
│   ├── BuildTool/ RunTestsTool/ TypecheckTool/  ← build, test and typecheck runners
│   ├── ContainerTool/ (14)      ← docker/compose ops; the domain logic is src/containers/
│   ├── RenameTool/              ← project-wide identifier rename (findSites.ts is the matcher)
│   ├── PowerShellTool/ (21)     ← the Windows shell, with its own permission and safety gates;
│   │                              pathValidation.ts is a BARREL over pathValidation/
│   │                              (cmdletPathConfig, paramMatching, pathAllowlist,
│   │                              dangerousRemoval, extractPaths, statementConstraints)
│   ├── WebFetchTool/ WebSearchTool/  ← Firecrawl or DuckDuckGo/raw
│   ├── LSPTool/                 ← read-only LSP ops (plugin-only; backend in platform/lsp/)
│   ├── EnterPlanModeTool/ ExitPlanModeTool/  ← planning
│   ├── AgentWorkflow/ (24)      ← the workflow ENGINE and the three tools that front it
│   │                              (WorkflowTool.ts, ListWorkflowsTool, WorkflowStatusTool).
│   │                              `tools/WorkflowTool/` is gone — it was four .d.ts
│   │                              stubs plus a constants.ts behind WORKFLOW_SCRIPTS
│   ├── SkillTool/ MonitorTool/ ScheduleCronTool/  ← skills, log monitors, cron
│   ├── EnterWorktreeTool/ ExitWorktreeTool/  ← worktree
│   ├── constants/               ← toolLimits.ts, tools.ts (names/descriptions)
│   └── shared/                  ← outputFilter/ (Bash noise stripping), diagnostics/ (shared
│                                  Build+Typecheck parsers), codeOutline/ (scanSymbols), stagedWrite/
├── platform/ (553)              ← the host: process, config, OS integration, telemetry
│   ├── entrypoints/ (16)        ← cli.tsx: process entry — fast-paths --version, defers heavy imports
│   ├── main/ (37)               ← boot sequence: bootContext, action, commands, dispatch
│   ├── headless/ (51)           ← headless -p / print mode, ndjson, exit handling
│   ├── config/ (22)             ← config.ts is a BARREL over config/ (types, defaults, fileStore,
│   │                              globalConfig, projectConfig, trust, derived); claudinMigration
│   ├── settings/ (35)           ← settings.json layers, precedence, remote-managed
│   ├── lifecycleHooks/ (40)     ← Claude Code lifecycle hooks (PreToolUse …). React hooks live in
│   │                              each slice's own hooks/ — these are the harness's
│   ├── bash/ (24)               ← bash parsing, command splitting, shell snapshots
│   ├── analytics/ (2)           ← feature-flag resolution ONLY, over
│   │                              ~/.claudin/feature-flags.json. The analytics and
│   │                              telemetry this was named for is deleted, not stubbed
│   ├── bootstrap/state.ts       ← a BARREL over state/ — the STATE singleton lives in state/store.ts
│   │                              and nowhere else; getSessionId, cwd helpers, cost, latches
│   ├── lsp/ ide/ install/ shell/ notifications/ secureStorage/
│   ├── migrations/ (13)         ← one-time settings/model migrations (migrateFennecToOpus …)
│   ├── bridge/ (40)             ← bridge mode (BRIDGE_MODE flag; largely gated/stubbed)
│   ├── teleport/ (11)           ← remote environments. `server/` is down to
│   │                              directConnectManager.ts: DIRECT_CONNECT was folded
│   │                              false, so its entry points and stubs are deleted
│   └── teams/ policyLimits/ wiki/ github/  ← misc host services
├── terminal/ (387)              ← the TUI shell: renderer, input, chrome (→ ink-tui.md)
│   ├── ink/ (115)               ← the forked Ink renderer: screen.ts, log-update, stringWidth, ScrollBox
│   ├── prompt-input/ (21)       ← the input box, its modes and suggestions. `input/` (8) is a
│   │                              different thing: Cursor, keyboardShortcuts, pasteStore
│   ├── hooks/ (24)              ← terminal-level React hooks (useTextInput …)
│   ├── theme/ (17)              ← theme.ts keeps getTheme and themeColorToAnsi over themes/,
│   │                              one module per palette plus types.ts (Theme, THEME_NAMES)
│   ├── design-system/ (17)      ← shared primitives; logo/ spinner/ image/ theme/ markdown/
│   ├── keybindings/ (15)        ← keybinding parser, defaultBindings, loadUserBindings, match
│   ├── contexts/ (9) state/ (8) ← React context providers + AppState store (getState/selectors).
│   │                              TUI state only — system-prompt context is agent/context.ts
│   ├── render/ (15)             ← fullscreen, render cadence, fpsTracker, streamJsonStdoutGuard
│   ├── prompt-suggestion/ (11)  ← ghost text, file suggestions, speculation
│   └── explorer/ vim/ wizard/ custom-select/ buddy/  ← dialogs and input modes
├── commands/ (238)              ← slash commands (/provider, /review, /plan, /resume, /mcp …),
│                                  one dir or file per command; registry in commands/commands.ts.
│                                  plugin/ (19) and install-github-app/ (17) are the big ones;
│                                  insights.ts is a BARREL over insights/ and must keep re-exporting
│                                  `default` — commands.ts reaches it through a dynamic import
├── permissions/ (153)           ← rules, classifiers, always-allow, and every permission dialog
│   ├── permissions.ts           ← hasPermissionsToUseTool, the decision core, over a
│   │                              permissions/ dir (ruleLookup, ruleMutation, requestMessage,
│   │                              denial). Re-exports but is NOT a pure barrel
│   ├── filePermissions.ts       ← a BARREL over filePermissions/ (dangerousPaths, internalPaths,
│   │                              rulePatterns, workingDirs, readWriteChecks, pathCase). Was
│   │                              filesystem.ts until 2026-09-19; `git log --follow` crosses it
│   ├── yoloClassifier.ts        ← a BARREL over yoloClassifier/ (prompts, transcript, xmlResponse,
│   │                              classifierConfig, autoModeDumps, classify). The .txt templates
│   │                              stay in yolo-classifier-prompts/ — build.ts hardcodes that path
│   ├── permissionSetup.ts       ← a BARREL over permissionSetup/ (dangerousRuleDetection,
│   │                              dangerousRuleStash, cliToolParsing, startupContext,
│   │                              autoModeGate, autoModeAvailability, bypassPermissions,
│   │                              planAutoMode, modeTransition). The feature()-gated require of
│   │                              the auto-mode state lives once, in autoModeStateBridge — five
│   │                              groups read it through there, none repeats the feature() block
│   ├── toolPermission/          ← per-mode handlers (interactive, coordinator, swarm worker)
│   └── ui/                      ← one request component per tool + rules/ editor
├── mcp/ (72)                    ← client/ (10: connection, transport, callTool, authCache),
│                                  mcpServerApproval trust dialog, ui/. auth.ts is a BARREL over
│                                  auth/ (serverKey, oauthErrors, authFetch, callbackParams,
│                                  tokenRevocation, oauthFlow, claudeAuthProvider,
│                                  clientSecretStore)
├── containers/ (18)             ← docker/compose domain: project discovery, state, diagnostics.
│                                  The TOOL is tools/ContainerTool/ and the task backend is
│                                  agent/tasks/ContainerTask/ — this slice is neither
│   ├── diagnostics/ (4)         ← log-error extraction, exit-code and health diagnosis
│   ├── docker/ (6)              ← CLI wrappers: ps/inspect, the `docker events` watcher
│   └── build/ (2)               ← compose build parsing and progress
├── sessions/ (89)               ← persistence/, resume/, indexing/, conversationRecovery, ui/,
│                                  peers/ (the cross-session inbox SendMessage and ListAgents
│                                  reach other local sessions through; docs/features/cross-session-messaging.md)
├── vcs/ (77)                    ← git/ (wrapper, gh PR status) + diff/ (the /diff reviewer).
│                                  git/worktree.ts is a BARREL over worktree/ (slugNaming,
│                                  session, mutationLock, tmuxSession, createWorktree,
│                                  includeFiles, postCreationSetup, sessionLifecycle)
├── plugins/ (54)                ← plugin discovery, install, marketplace, dxt/, hooks/ (4)
├── memory/ (70)                 ← auto-memory: memdir/ (project-local <repo>/.claudin/memory/),
│                                  extract/, autoDream/, session/, ui/, and instructions/ —
│                                  memdir/pathScopedMemories.ts is the on-demand loader (a
│                                  memory with `paths:` rides the rules' nested_memory lane),
│                                  memdir/memoryTypes.ts holds TEAM_CATEGORIES (decisions/
│                                  bugs/docs, the one source every memory prompt renders);
│                                  claudemd.ts loads AGENTS.md/CLAUDE.md + .claudin/rules/*.md
│                                  over claudemd/ (parsing, includes, exclusions, processing,
│                                  predicates, nestedDirectories, externalIncludes); the memoized
│                                  getMemoryFiles and the TEAMMEM-gated require stay in the root,
│                                  rulesClaims/rulesMapSync/ruleMapAutoSync verify and refresh
│                                  THIS file's tree and counts at session start
├── skills/ (28)                 ← user-invocable skills (/<name>); bundled/ + /create authoring
├── shared/ (162)                ← cross-cutting primitives ONLY — a subsystem here is a bug.
│   │                              moduleBoundaries.test.ts pins how many imports reach UP from
│   │                              here into a slice (131) — a ceiling that only goes down
│   ├── fs/ (33)                 ← path.ts, glob.ts, ripgrep.ts, textEncoding.ts, file IO
│   ├── data/ proc/ text/        ← pure data helpers, Shell.ts/execFileNoThrow, string/format
│   ├── constants/ types/        ← the genuinely shared ones; feature constants live in their slice
│   ├── schemas/                 ← shared zod schemas
│   └── errors.ts log.ts env*.ts ← ClaudeError/isAbortError/isSdk* guards, logError, env helpers
├── native-ts/ (5)               ← TS ports to avoid native addons: yoga-layout, color-diff, file-index
├── stubs/ (2)                   ← build-time stubs
└── __tests__/ (10)              ← cross-cutting tests: bugfixes, moduleBoundaries,
                                   mockModuleTargets, security-hardening
```

The seven catch-all directories the reorg retired — `components/`, `services/`,
`utils/`, `screens/`, `constants/`, `hooks/`, `types/` — are gone, and
`src/__tests__/moduleBoundaries.test.ts` fails if one comes back. If you are
about to create one, the file belongs in the slice that owns it, or in
`shared/` when it genuinely has no owner.

### Root files worth knowing

Not under `src/`, but among the most-opened files in practice:

| File | What it answers |
|------|-----------------|
| `package.json` | the script names (`build`, `smoke`, `verify:*`, `typecheck:ci`) and which deps are real vs stubbed |
| `tsconfig.json` | the `src/…` path aliases and the compiler settings the typecheck backlog is measured against |
| `bunfig.toml` | the test runner's preload/config — start here when a test behaves differently under `bun test` than standalone |
| `AGENTS.md` | repo orientation, loaded every turn: the slice layout, where a new file goes, the import convention. On-by-default runtime behaviors are NOT here — each is documented at the top of the module that implements it |
| `typecheck-baseline.json` | the ratchet's recorded backlog (`bun run typecheck:baseline` regenerates) |

## Feature flags

`featureFlags` in `scripts/build/build.ts` is the build-time set.
`bun run scripts/verify/tengu-census.ts --gates` lists every runtime gate key
with its call sites, and `docs/tech/tengu-census/gate-audit.md` classifies all
104: which do something, which open a branch that is dead on arrival, which are
inert. Flip one by writing `~/.claudin/feature-flags.json`. There is no
analytics to grep for — `logEvent` and the modules behind it were removed.

## Claudin-Specific Navigation Rules

### Adding a new tool

1. Check `src/tools/Tool.ts` for `buildTool` signature
2. Copy structure from a similar tool (e.g. `src/tools/GrepTool/GrepTool.ts` for search tools); the entry file is `<Name>Tool.ts(x)`, not `index.ts`
3. Register in the dynamic registry `src/tools/tools.ts` (built per-context: sandbox/plan/coordinator/MCP)
4. Add zod schema, `execute`, and a colocated `.test.ts`

### Debugging provider issues

1. Start at `src/providers/presets/activeProvider.ts` → `tryGetActiveProvider()`
2. Check `src/platform/config/config.ts` → `getGlobalConfig()` for stored profile
3. Check `src/providers/presets/providerConfig.ts` for preset definitions
4. Run `/provider doctor` from inside the REPL after `bun run dev`

### "This used to be in src/utils/ (or services/, components/, screens/) — where is it now?"

`scripts/migrations/reorg/manifest.ts` records every destination the reorg used, grouped by
the batch that moved it and annotated with why, so it answers the question
directly. Failing that, `git log --follow --diff-filter=R -- <old-path>` finds
the rename — every group was committed as pure renames, so `--follow` works
across the whole reorg.

A search that comes back empty may be looking for something that left the repo
rather than moved. The headless gRPC service was **removed** in #22 — `src/grpc/`
and `src/proto/claudin.proto` no longer exist, nor do the `dev:grpc*` scripts —
and the bundled VS Code extension was **deleted** in #90 (fcbcbc11). Older docs
and commit messages still mention both.

### Debugging tool output

1. Find tool dir: `src/tools/<ToolName>/`
2. Look at `execute()` in the entry file `<ToolName>Tool.ts(x)` (tools don't use `index.ts`)
3. Check `src/tools/shared/` for shared helpers
4. Check `src/agent/tools/toolResultStorage.ts` for large output persistence

### Build issues (feature() preprocessing)

1. Run `git diff` immediately — check if source files were mutated by a killed build
2. If files show `true`/`false` instead of `feature('X')` — restore with `git checkout`
3. Check `scripts/build/build.ts` → `featureFlags` map for enabled/disabled flags
4. Run `bun run build` again cleanly

### Configuration issues

1. Config file: `~/.claudin/settings.json`
2. `src/platform/config/config.ts` → `getGlobalConfig()` / `saveGlobalConfig()`
3. Config dir override: `CLAUDIN_CONFIG_DIR` env var
4. V8 cache: `~/.claudin/v8cache/` — delete to force cold-start if caching issues

## Anti-Patterns

❌ **Don't** look for model names as strings — they're resolved dynamically via `getPrimaryModel()`
