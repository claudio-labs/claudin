---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---
# Search Strategy — Claudin Codebase Navigation

Efficient navigation patterns for Claudin's TypeScript codebase.

## Priority Order

1. **Grep** (exact symbol/string, fast) → for known function names, types, imports
2. **Glob** (file discovery) → for finding modules by name or pattern
3. **Read** (full file) → only after locating the right file
4. **Explore agent** (broad research) → last resort for >3 queries

Never use Bash `find`/`grep` for code search — use dedicated Grep/Glob tools.

## Module Map

Approximate `.ts(x)` counts in `(N)` — the big dirs (`utils`, `components`,
`tools`, `services`) are where most code lives, so always Grep/Glob inside them
rather than reading broadly. Cross-refs point to the rule that owns that subsystem.

```
src/
├── entrypoints/ (12)            ← cli.tsx: process entry — fast-paths --version, defers heavy imports
├── QueryEngine.ts               ← agent loop: model drive, tool dispatch, streaming, compaction
├── query.ts                     ← query helpers, SDKMessage types (see also query/ for config/deps)
├── query/ (4)                   ← config.ts, deps.ts, stopHooks.ts, tokenBudget.ts
├── Tool.ts                      ← central type system: Tool, Tools, ToolUseContext, buildTool()
├── tools.ts                     ← dynamic tool registry (sandbox/plan/coordinator/MCP-aware)
├── tools/ (326)                 ← built-in tools, one dir per tool
│   ├── BashTool/                ← shell execution, permissions, sandbox
│   ├── FileReadTool/ FileEditTool/ FileWriteTool/ NotebookEditTool/  ← file IO
│   ├── GrepTool/ GlobTool/      ← ripgrep + glob wrappers
│   ├── AgentTool/               ← sub-agent spawning (built-in agents in built-in/)
│   ├── TaskCreateTool/ …        ← task tool surface (runtime backends live in src/tasks/)
│   ├── WebFetchTool/ WebSearchTool/  ← Firecrawl or DuckDuckGo/raw
│   ├── LSPTool/                 ← read-only LSP ops (plugin-only; backend in services/lsp/)
│   ├── EnterPlanModeTool/ ExitPlanModeTool/ VerifyPlanExecutionTool/  ← planning
│   ├── WorkflowTool/ SkillTool/ MonitorTool/ ScheduleCronTool/  ← workflow
│   ├── EnterWorktreeTool/ ExitWorktreeTool/  ← worktree (safety → agent-safety.md)
│   └── shared/                  ← cross-tool helpers
├── services/ (298)
│   ├── api/                     ← provider abstraction (start here for provider issues)
│   │   ├── client.ts            ← SDK builder for all providers
│   │   ├── activeProvider.ts    ← active provider resolver
│   │   ├── openaiShim.ts        ← Anthropic → OpenAI Chat Completions (~2.2k lines)
│   │   ├── codexShim.ts         ← ChatGPT/Codex OAuth adapter
│   │   ├── providerConfig.ts    ← presets, profile schema, credential/OAuth storage
│   │   ├── claude/              ← Anthropic renderer, paramBuilders, cacheControl (→ cache.md)
│   │   ├── withRetry.ts errors.ts errorUtils.ts  ← retry + error classification
│   │   └── (adding a preset? use the /add-provider-preset skill)
│   ├── cache/                   ← prompt/tool-result cache policy (→ cache.md)
│   ├── tools/                   ← toolExecution, toolResultCache, cacheInvalidation (→ cache.md)
│   ├── mcp/                     ← MCP client + server connection mgmt; mcpServerApproval trust dialog
│   ├── compact/                 ← conversation compaction + sessionMemoryCompact
│   ├── extractMemories/ SessionMemory/ teamMemorySync/  ← auto-memory subsystem
│   ├── oauth/                   ← token store, PKCE, callback server (reused by all OAuth providers)
│   ├── lsp/                     ← LSP client service
│   ├── github/ settingsSync/ policyLimits/ tips/ wiki/  ← misc services
│   └── analytics/               ← GrowthBook, logEvent (telemetry stubbed at build time)
├── commands/ (219)             ← slash commands (/provider, /review, /plan, /resume, /mcp …); registry in src/commands.ts
├── components/ (459)           ← Ink React TUI components (→ ink-tui.md; some are committed React-Compiler output)
├── ink/ (109)                  ← the forked Ink renderer: screen.ts, log-update, stringWidth, ScrollBox (→ ink-tui.md)
├── native-ts/ (5)              ← TS ports to avoid native addons: yoga-layout, color-diff, file-index
├── screens/ (32)               ← REPL.tsx (main loop), ResumeConversation, StartupScreen
├── hooks/ (118)                ← React hooks, file suggestions, prompt-suggestion ghost, notifs
├── context/ (9) state/ (8)     ← React context providers + AppState store (getState/selectors)
├── keybindings/ (14)           ← keybinding parser, defaultBindings, loadUserBindings, match
├── outputFilter/ (51)          ← command-aware Bash output filter (noise stripping/rewrites)
├── main/ (44)                  ← boot sequence: bootContext, argvPreparse, action, commands
├── cli/ (40)                   ← headless -p / print mode, ndjson, exit handling
├── coordinator/ (3)            ← multi-agent coordinator (COORDINATOR_MODE flag)
├── tasks/ (13)                 ← task runtime backends: LocalAgentTask, MonitorMcpTask, DreamTask …
├── memdir/ (14)                ← auto-memory dir I/O (project-local <repo>/.claudin/memory/ by default)
├── skills/ (27)                ← user-invocable skills (/<name>); bundled/ + /create authoring
├── migrations/ (11)            ← one-time settings/model migrations (migrateFennecToOpus …)
├── bridge/ (32)                ← bridge mode (BRIDGE_MODE flag; largely gated/stubbed)
├── constants/ (36) types/ (12) ← shared constants + types
├── utils/ (846)               ← the catch-all; key anchors:
│   ├── errors.ts               ← ClaudeError, AbortError, isAbortError, isENOENT, isSdk* guards
│   ├── log.ts                  ← logError, logForDebugging
│   ├── config.ts               ← getGlobalConfig, saveGlobalConfig
│   ├── model/model.ts          ← getPrimaryModel, getSmallFastModel, getContextWindowForModel
│   ├── model/providers.ts      ← getAPIProvider, isFirstPartyAnthropicBaseUrl
│   ├── providerProfiles.ts     ← ProviderPreset union + getProviderPresetDefaults
│   ├── claudinMigration.ts     ← ~/.claude ↔ ~/.claudin one-time migration
│   ├── Shell.ts envUtils.ts path.ts  ← exec wrapper, env helpers, path expansion
│   └── claudemd.ts             ← AGENTS.md/CLAUDE.md + .claudin/rules/*.md loader (rule path matching)
└── bootstrap/
    └── state.ts                ← getSessionId, getIsNonInteractiveSession, cwd helpers
```

## Common Search Patterns

### "Where is slash command X handled?"

```
Grep pattern="'/provider'\|createCommand\b" path="src/commands/"
# Then: Read src/commands/provider/index.ts
```

### "Where is tool X defined?"

```
Glob pattern="src/tools/*/*Tool.ts*"   # entry file is <Name>Tool.ts(x), NOT index.ts
Grep pattern="buildTool\(" path="src/tools/"
```

### "Where is function X defined?"

```
Grep pattern="export function myFunction\|export const myFunction" type="ts"
```

### "Where is provider Y handled?"

```
# Start at activeProvider.ts — it's the central resolver
Read src/services/api/activeProvider.ts

# For shim logic:
Grep pattern="'openai_compat'\|'gemini'\|'mistral'" path="src/services/api/openaiShim.ts"
```

### "Which feature flags exist?"

```
Grep pattern="feature\('" path="scripts/build.ts"
```

### "Where is analytics event X logged?"

```
Grep pattern="logEvent\|_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS" type="ts"
```

### "Where is the Bash output filtered / a command rewritten?"

```
# Command-aware filters + pre-exec rewrites live here
Glob pattern="src/outputFilter/Bash/*.ts"
Grep pattern="rewrite\|canonicaliz" path="src/outputFilter/"
```

### "Where does a task/agent actually run (the backend behind TaskCreate)?"

```
# The tool surface is src/tools/TaskCreateTool/; the runtime backends are:
Glob pattern="src/tasks/**/*.ts"   # LocalAgentTask, MonitorMcpTask, DreamTask, …
```

### "Which files have tests?"

```
Glob pattern="src/**/*.test.ts"
```

### "Find all zod schemas"

```
Grep pattern="z\.object\(\|z\.string\(\|z\.union\(" type="ts" output_mode="files_with_matches"
```

## Claudin-Specific Navigation Rules

### Adding a new tool

1. Check `src/Tool.ts` for `buildTool` signature
2. Copy structure from a similar tool (e.g. `src/tools/GrepTool/GrepTool.ts` for search tools); the entry file is `<Name>Tool.ts(x)`, not `index.ts`
3. Register in the dynamic registry `src/tools.ts` (built per-context: sandbox/plan/coordinator/MCP)
4. Add zod schema, `execute`, and a colocated `.test.ts`

### Debugging provider issues

1. Start at `src/services/api/activeProvider.ts` → `tryGetActiveProvider()`
2. Check `src/utils/config.ts` → `getGlobalConfig()` for stored profile
3. Check `src/services/api/providerConfig.ts` for preset definitions
4. Run `/provider doctor` from inside the REPL after `bun run dev`

### Debugging tool output

1. Find tool dir: `src/tools/<ToolName>/`
2. Look at `execute()` in the entry file `<ToolName>Tool.ts(x)` (tools don't use `index.ts`)
3. Check `src/tools/shared/` for shared helpers
4. Check `src/utils/toolResultStorage.ts` for large output persistence

### Build issues (feature() preprocessing)

1. Run `git diff` immediately — check if source files were mutated by a killed build
2. If files show `true`/`false` instead of `feature('X')` — restore with `git checkout`
3. Check `scripts/build.ts` → `featureFlags` map for enabled/disabled flags
4. Run `bun run build` again cleanly

### Configuration issues

1. Config file: `~/.claudin/settings.json`
2. `src/utils/config.ts` → `getGlobalConfig()` / `saveGlobalConfig()`
3. Config dir override: `CLAUDIN_CONFIG_DIR` env var
4. V8 cache: `~/.claudin/v8cache/` — delete to force cold-start if caching issues

## Anti-Patterns

❌ **Don't** read all `*.test.ts` files to find a pattern — Grep for `describe\|test\b`
❌ **Don't** use Bash `find src -name "*.ts"` — use Glob
❌ **Don't** read `QueryEngine.ts` entirely — it's large; Grep for the specific method
❌ **Don't** look for model names as strings — they're resolved dynamically via `getPrimaryModel()`

## Dependency Check

```
# Check if a package is already installed (before adding)
Grep pattern="\"zod\"\|\"@anthropic-ai" path="package.json"

# Find all places a utility is used
Grep pattern="from 'src/utils/errors.js'" type="ts"

# Find feature-gated code paths
Grep pattern="feature\('MY_FLAG'\)" type="ts"
```
