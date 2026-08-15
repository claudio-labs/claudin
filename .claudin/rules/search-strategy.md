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

A content-mode Grep result over ~6 KB is regrouped by file before it reaches the
model, and its `-A/-B/-C` context is clamped to ±3 lines around each match
(`summarizeGrepOutput` in `src/agent/tools/toolResultSummarizer.ts`). So asking for
`-C 30` on a wide search does not buy 30 lines of context — scope the search
instead, or re-run against the one file you care about. Between ~3 KB and ~6 KB
the same regrouping applies, but only when it costs no match line: a result
dense enough that one file exceeds 10 matches is sent whole rather than capped,
so a *match locator* is never traded away below the full threshold.

A **broad** content search goes further and comes back as the symbol map
(`output_mode:"symbols"`) instead of the lines: ≥5 distinct files AND either
≥6 KB or ≥60 match lines, with no explicit `head_limit` and no `offset`
(`src/tools/GrepTool/autoPivot.ts` — the search-side twin of the Read
auto-outline). The map only ships when it is ≤70% of the lines it replaces, and
the result reports how much wider the search actually was. To get the lines
anyway, pass `head_limit` yourself or narrow with `path`/`glob`;
`CLAUDIN_DISABLE_GREP_AUTO_PIVOT=1` turns it off for the session. Note that the
30s tool-result cache keys on the input alone, so flipping that env mid-session
does not re-answer a search it already served.

`Glob` returns at most **100 paths per call**, ranked most-recently-modified
first (`--sortr=modified` in `src/shared/fs/glob.ts`), so what the cap drops is the
files nobody has touched. That ranking is the same one Grep's
`files_with_matches` mode applies, and it is load-bearing twice over: the
summarizer trims the result again to the first 50 paths
(`GLOB_MAX_PATHS` in `src/agent/tools/toolResultSummarizer.ts`), so on a wide pattern
the model sees the 50 newest matches and nothing else. A truncated result names
the `offset` to pass for the next page — that is the way to reach the rest,
narrowing the pattern being the other. Ordering is by mtime, not relevance: a
freshly checked-out `node_modules` still outranks `src/` when the pattern
reaches it, so scope with `path` rather than paging.

## What a search does NOT cover

The two tools disagree about `.gitignore`, on purpose, and the asymmetry is the
thing to hold in your head. `Glob` passes `--no-ignore` (`src/shared/fs/glob.ts`),
so it lists ignored paths and walks `node_modules/`. `Grep` does not, so a
pattern living only in `dist/`, in generated code or in a vendored tree is
outside the files it reads.

What keeps that from being a silent miss is that a Grep returning **zero**
results runs a second pass with `--no-ignore` before answering. If that pass
finds something, those are the results you get, headed by the count and the
fact that they came from excluded files. So "No matches found" from Grep means
no matches anywhere, and a labelled result means the only copies are outside
version control. `no_ignore: true` searches them from the start (one pass, no
label); `CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK=1` removes the second pass and
with it that guarantee. The retry costs a full extra walk, so it deliberately
fires only on the empty result.

Three more things a search does not reach by default, each with a way in:

- **Case.** Matching is ripgrep smart-case: an all-lowercase pattern matches any
  case, a pattern carrying an uppercase letter does not. `-i: true` and
  `-i: false` force it either way — `-i: false` is no longer inert.
- **Binary files.** Skipped entirely; `binary: true` (`rg -a`) searches them as
  text, which is how you find a string inside a `.dat` or a compiled artifact.
- **Non-UTF-8 text.** Only a BOM is sniffed, so a UTF-16 file without one reads
  as binary and is skipped. `encoding: "utf-16le"` (or any Encoding Standard
  label — `shift_jis`, `windows-1252`, `euc-jp`, `gbk`) decodes it, and the
  same label is what `Read` and the symbol map take (see below).

`encoding` carries all the way through, which is the part worth remembering:
finding a match in a Shift-JIS file is half an answer if the follow-up cannot
open it. One label reaches three places — the search itself (ripgrep's
`--encoding`), the symbol map (`buildSymbolsOutput` decodes each file it scans,
so `output_mode: "symbols"` over UTF-16 returns real signatures instead of
"(matched outside any symbol)"), and `Read(file_path, encoding: …)`, which
covers a full read, a range, `view: "outline"` and `symbol:` alike. All three
share `src/shared/fs/textEncoding.ts`, so an unknown label is refused the same way
everywhere rather than degrading into mojibake. Note the map still prints a
*signature* while `Read`'s `symbol` matches on a *name*, so the round trip
means reading `makeWidget` out of `export function makeWidget(id: string)`.

Finally, an empty result is no longer overloaded. ripgrep exits 2 both when it
refuses an invocation and when it fails to read a path, and `ripGrep()` used to
resolve both to `[]` — so an **invalid regex answered "No matches found"**.
`ripGrepWithStatus()` (`src/shared/fs/ripgrep.ts`) separates them: a refusal is
re-thrown carrying ripgrep's own message, an unreadable directory still returns
results, and a run cut short by the 20s timeout or the 20 MB buffer comes back
labelled INCOMPLETE instead of passing as a finished search. Grep and Glob both
report that label; the other four `ripGrep()` callers keep the lines-only
signature.

`Build` is the artifact-producing sibling of `Typecheck` — same
detect/parse/budget/redirect family, different job. It runs the project's build
(cargo, gradle, maven, sbt, msbuild, cmake/make/ninja, swift, zig, mix, rebar3,
and the `build` script of a package.json, among others) and returns the
diagnostics with `file:line` plus a source excerpt instead of the progress log.
Two things it does that the check lane does not: it extracts the **failure
block** for a failure that carries no position
(`src/tools/BuildTool/failureBlock.ts` — a Gradle `* What went wrong:`, a Maven
goal failure, a cargo linker error, a `make: *** Error 2`), and it reports an
incremental **no-op** as "up to date, nothing rebuilt" rather than as a clean
build (`noOp.ts`), because a cached run compiles nothing and `0 warnings` would
describe a compilation that never happened. There is no baseline here,
deliberately: a second run prints nothing, and recording that would mark the
whole backlog as newly introduced.

The run is stopped after a stretch with **no output at all** (`idleTimeout`,
default 180s) under a wall ceiling (`timeout`, default 600s), and the result
says how long it ran, how long it had been silent and the last line it printed —
as observations, since linking and a cold daemon are legitimately quiet. While
it runs, the tool block shows the phase it is in — `cargo · Compiling syn
v1.0.109`, `ninja · [312/847] …`, or `silent for 40s` once the output stops
(`progressLine.ts`). That label and the idle watchdog share one tick: both ride
`ExecOptions.onProgress`, which needs BOTH the callback passed to `exec` and a
`TaskOutput.startPolling` call — the tool makes that call itself, so it works
headless and with the block collapsed. Progress messages are dropped before
serialization, so none of this reaches the model. Diagnostic parsers are shared with
`Typecheck` in `src/tools/shared/diagnostics/`; the chain takes a parser LIST
and MERGES the native ones, so one Gradle run reports its Kotlin and its javac
errors together. `CLAUDIN_DISABLE_BUILD_TOOL=1` removes the tool,
`CLAUDIN_DISABLE_BUILD_REDIRECT=1` only the Bash refusal — which is narrowed to
the noisy toolchains (`npm run build` is deliberately never refused, its output
being already short) and never fires for a command that also installs,
publishes or runs something.

`git` and `gh` are the fourth lane of the same idea. A Bash command that only
READS the repository — `git diff|log|status|show|blame`, `gh pr view|list|checks|diff`,
`gh issue view`, `gh run view`
— is refused once with the `Git` call to make instead, and re-sending the
identical command runs it (`src/tools/GitTool/redirect.ts`,
`CLAUDIN_DISABLE_GIT_REDIRECT=1`). A trailing `| head -50`-style trim is stripped
before that decision, so a piped read still redirects; mutations are never
refused, since a dialog in front of a `git push` buys nothing. What counts as
ONE command there is the grammar's own `acceptsGitCommand` (the quoting scan
described below), not a ban on punctuation — so `git log --format='%h %s%n%b'`
and `gh run view … --jq '…'` redirect, their `|` being inside quotes, while an
operator outside quotes stays in Bash. The `gh` side is
deliberately narrower than what the tool ACCEPTS (24 read-only command pairs,
`grammar.ts`): only the shapes with a renderer behind them are refused, because
a refusal costs a round-trip and the tool hands a table like `gh run list` back
unchanged. The tool takes a
**list** — `Git({commands:["git status","git diff","git log -5"]})` — so a burst
that would have been three Bash calls is one call and one result.

What it accepts is scanned with bash's own quoting rules
(`scanShellHazards` in `grammar.ts`), not with a blanket ban on punctuation. An
operator only composes OUTSIDE quotes, so a quoted argument may hold `;`, `|`,
`<`, `>` and — the point of the rule — newlines: a multi-line `git commit -m`
or `gh pr create --body` goes through the tool, and the commit protocol
prescribes that instead of a Bash HEREDOC. What is refused is what the shell
would rewrite before git saw it: `$(…)`, an unescaped `$` and a backtick
outside single quotes, since inside `'…'` both are literal (which is what a PR
body full of backticks needs). Arguments are then resolved through shell-quote,
so a flag inside a message is an argument rather than a flag —
`git stash push -m "wip -p x"` used to be refused as patch mode.

The message TEXT is never inspected past that scan. `hasMalformedTokens` — the
Bash permission path's guard against an unquoted `{"a":"b;evil"}` hiding a
second command — is deliberately NOT called from `resolveArgs`: everything it
defends against is already refused by the scan, and what was left of it was its
balance test running over prose. An apostrophe in "each arm's own", a
`renderBody(` mid-sentence or a stray `]` counted as unbalanced and sent the
commit to Bash; over this repo's last 100 commit messages it alone refused 21,
every one of which shell-quote had tokenized exactly as bash does. With it gone
and the protocol's quoting rule (`'…'` for a backtick or `$`, otherwise `"…"`
with `"` and `\` backslash-escaped — and the backtick and `$` too when an
apostrophe rules `'…'` out), all 100 are accepted and reach git byte-for-byte,
so no commit or PR body needs a Bash HEREDOC.

What comes back is budgeted. A unified diff at or above 6 KB, or touching 6+
files, loses its hunks for a stat table naming the command that fetches one
file's hunks back; below that each file gets 60 lines before the remainder is
named (`src/tools/GitTool/parsers/diff.ts`) — `gh pr diff` routes through that
same renderer, and `gh run view --log` through the CI-log one (job/step headers
hoisted, timestamps and `##[group]` markers dropped, tail kept). Re-running an identical read returns
only the sections that changed — the stat table still lists every file, with the
ones you already received marked `unchanged, elided` — or
`CLAUDIN_DISABLE_GIT_DELTA=1` to turn that lane off. `full: true` is the escape
from all of it: no summary, no elision, and no Bash-filter rewrite either, so
`full: true` on `git log` is the real log and not the `--oneline` one. It is the
answer to a diff too wide to come back whole, and past the 30k result cap the
harness persists the body to a file rather than truncating it. Both
lanes ship a summary only when it is ≤70% of what it replaces, and a FAILING
command is never budgeted or elided: it gets a one-line diagnosis prepended and
keeps its raw text. `CLAUDIN_DISABLE_GIT_TOOL=1` removes the tool, and with it
the redirect.

## Module Map

Approximate `.ts(x)` counts in `(N)`, measured 2026-08-14 — the big dirs
(`services`, `components`, `tools`) are where most code lives, so always
Grep/Glob inside them rather than reading broadly. Cross-refs point to the rule
that owns that subsystem.

```
src/
├── entrypoints/ (16)            ← cli.tsx: process entry — fast-paths --version, defers heavy imports
├── QueryEngine.ts               ← agent loop: model drive, tool dispatch, streaming, compaction
├── query.ts                     ← query helpers, SDKMessage types (see also query/ for config/deps)
├── query/ (7)                   ← config.ts, deps.ts, stopHooks.ts, tokenBudget.ts
├── context.ts                   ← getSystemContext/getUserContext: the memoized system-prompt
│                                  context blocks (git status, dir structure). NOT src/terminal/contexts/,
│                                  and NOT services/context/ (token accounting) — three different things
├── Tool.ts                      ← central type system: Tool, Tools, ToolUseContext, buildTool()
├── tools.ts                     ← dynamic tool registry (sandbox/plan/coordinator/MCP-aware)
├── tools/ (469)                 ← built-in tools, one dir per tool
│   ├── BashTool/                ← shell execution, permissions, sandbox
│   ├── FileReadTool/ FileEditTool/ FileWriteTool/ NotebookEditTool/  ← file IO
│   ├── GrepTool/ GlobTool/      ← ripgrep + glob wrappers
│   ├── GitTool/                 ← git + gh, batched; permissions delegate to BashTool's
│   ├── AgentTool/               ← sub-agent spawning (built-in agents in built-in/)
│   ├── TaskCreateTool/ …        ← task tool surface (runtime backends live in src/agent/tasks/)
│   ├── WebFetchTool/ WebSearchTool/  ← Firecrawl or DuckDuckGo/raw
│   ├── LSPTool/                 ← read-only LSP ops (plugin-only; backend in services/lsp/)
│   ├── EnterPlanModeTool/ ExitPlanModeTool/ VerifyPlanExecutionTool/  ← planning
│   ├── WorkflowTool/ SkillTool/ MonitorTool/ ScheduleCronTool/  ← workflow
│   ├── EnterWorktreeTool/ ExitWorktreeTool/  ← worktree (safety → agent-safety.md)
│   └── shared/                  ← cross-tool helpers
├── services/ (832)              ← one dir per subsystem; the reorg moved most of src/utils here
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
│   ├── session/                 ← sessionStorage, resume/restore, conversationRecovery, spill dirs
│   ├── config/                  ← config.ts (getGlobalConfig/saveGlobalConfig), claudinMigration
│   ├── permissions/             ← permission rules, always-allow, classifier approvals
│   ├── plugins/                 ← plugin discovery, install, marketplace
│   ├── bash/                    ← bash parsing, command splitting, shell snapshots
│   ├── lifecycleHooks/          ← Claude Code lifecycle hooks (PreToolUse …) — NOT src/hooks/, which is React
│   ├── context/                 ← token accounting + context-window math — NOT src/terminal/contexts/, which is React
│   ├── instructions/            ← claudemd.ts: AGENTS.md/CLAUDE.md + .claudin/rules/*.md loader
│   ├── git/ shell/ messages/ attachments/ settings/ install/ computerUse/  ← moved subsystems
│   ├── compact/                 ← conversation compaction + sessionMemoryCompact
│   ├── extractMemories/ SessionMemory/ teamMemorySync/  ← auto-memory subsystem
│   ├── oauth/                   ← token store, PKCE, callback server (reused by all OAuth providers)
│   ├── lsp/                     ← LSP client service
│   ├── github/ settingsSync/ policyLimits/ tips/ wiki/  ← misc services
│   └── analytics/               ← GrowthBook, logEvent (telemetry stubbed at build time)
├── commands/ (224)             ← slash commands (/provider, /review, /plan, /resume, /mcp …); registry in src/commands/commands.ts
├── components/ (481)           ← Ink React TUI components (→ ink-tui.md; some are committed React-Compiler output)
├── ink/ (109)                  ← the forked Ink renderer: screen.ts, log-update, stringWidth, ScrollBox (→ ink-tui.md)
├── native-ts/ (5)              ← TS ports to avoid native addons: yoga-layout, color-diff, file-index
├── screens/ (36)               ← REPL.tsx (main loop), ResumeConversation, StartupScreen
├── hooks/ (117)                ← React hooks only (use*) — lifecycle hooks are services/lifecycleHooks/
├── context/ (9) state/ (8)     ← React context providers + AppState store (getState/selectors).
│                                 The TUI providers only — the system-prompt context is src/agent/context.ts
│                                 and the token accounting is services/context/
├── keybindings/ (15)           ← keybinding parser, defaultBindings, loadUserBindings, match
├── outputFilter/ (51)          ← command-aware Bash output filter (noise stripping/rewrites)
├── main/ (44)                  ← boot sequence: bootContext, argvPreparse, action, commands
├── cli/ (51)                   ← headless -p / print mode, ndjson, exit handling
├── coordinator/ (39)           ← multi-agent coordinator (COORDINATOR_MODE flag)
├── tasks/ (27)                 ← task runtime backends: LocalAgentTask, MonitorMcpTask, DreamTask …
├── memdir/ (20)                ← auto-memory dir I/O (project-local <repo>/.claudin/memory/ by default)
├── skills/ (27)                ← user-invocable skills (/<name>); bundled/ + /create authoring
├── migrations/ (11)            ← one-time settings/model migrations (migrateFennecToOpus …)
├── bridge/ (32)                ← bridge mode (BRIDGE_MODE flag; largely gated/stubbed)
├── constants/ (40) types/ (22) ← shared constants + types
├── utils/ (292)                ← primitives only since the reorg — a subsystem here is a bug:
│   ├── data/ (26)              ← pure data helpers
│   ├── fs/ (35)                ← path.ts, glob.ts, ripgrep.ts, textEncoding.ts, file IO
│   ├── proc/ (19)              ← Shell.ts, execFileNoThrow, process helpers
│   ├── text/ (14)              ← string/format helpers
│   ├── model/ (42)             ← model.ts (getPrimaryModel, getContextWindowForModel),
│   │                             providers.ts (getAPIProvider). Stays here on purpose — see testing.md
│   ├── errors.ts               ← ClaudeError, AbortError, isAbortError, isENOENT, isSdk* guards
│   ├── log.ts theme.ts envUtils.ts  ← logError/logForDebugging, theme, env helpers
│   └── (~121 loose files left at the root — the next slice of the same cleanup)
└── bootstrap/
    └── state.ts                ← getSessionId, getIsNonInteractiveSession, cwd helpers
```

### Root files worth knowing

Not under `src/`, but among the most-opened files in practice:

| File | What it answers |
|------|-----------------|
| `package.json` | the script names (`build`, `smoke`, `verify:*`, `typecheck:ci`) and which deps are real vs stubbed |
| `tsconfig.json` | the `src/…` path aliases and the compiler settings the typecheck backlog is measured against |
| `bunfig.toml` | the test runner's preload/config — start here when a test behaves differently under `bun test` than standalone |
| `AGENTS.md` | repo orientation; the toggle table for on-by-default runtime behaviors |
| `typecheck-baseline.json` | the ratchet's recorded backlog (`bun run typecheck:baseline` regenerates) |

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
Read src/providers/presets/activeProvider.ts

# For shim logic:
Grep pattern="'openai_compat'\|'gemini'\|'mistral'" path="src/providers/shims/openaiShim.ts"
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
Glob pattern="src/tools/shared/outputFilter/Bash/*.ts"
Grep pattern="rewrite\|canonicaliz" path="src/tools/shared/outputFilter/"
```

### "Where does a task/agent actually run (the backend behind TaskCreate)?"

```
# The tool surface is src/tools/TaskCreateTool/; the runtime backends are:
Glob pattern="src/agent/tasks/**/*.ts"   # LocalAgentTask, MonitorMcpTask, DreamTask, …
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

1. Check `src/tools/Tool.ts` for `buildTool` signature
2. Copy structure from a similar tool (e.g. `src/tools/GrepTool/GrepTool.ts` for search tools); the entry file is `<Name>Tool.ts(x)`, not `index.ts`
3. Register in the dynamic registry `src/tools/tools.ts` (built per-context: sandbox/plan/coordinator/MCP)
4. Add zod schema, `execute`, and a colocated `.test.ts`

### Debugging provider issues

1. Start at `src/providers/presets/activeProvider.ts` → `tryGetActiveProvider()`
2. Check `src/platform/config/config.ts` → `getGlobalConfig()` for stored profile
3. Check `src/providers/presets/providerConfig.ts` for preset definitions
4. Run `/provider doctor` from inside the REPL after `bun run dev`

### "This used to be in src/utils/ — where is it now?"

`scripts/reorg/manifest.ts` records every one of the 708 destinations the reorg
used, so it answers the question directly. Failing that, `git log --follow
--diff-filter=R -- <old-path>` finds the rename.

### Debugging tool output

1. Find tool dir: `src/tools/<ToolName>/`
2. Look at `execute()` in the entry file `<ToolName>Tool.ts(x)` (tools don't use `index.ts`)
3. Check `src/tools/shared/` for shared helpers
4. Check `src/agent/tools/toolResultStorage.ts` for large output persistence

### Build issues (feature() preprocessing)

1. Run `git diff` immediately — check if source files were mutated by a killed build
2. If files show `true`/`false` instead of `feature('X')` — restore with `git checkout`
3. Check `scripts/build.ts` → `featureFlags` map for enabled/disabled flags
4. Run `bun run build` again cleanly

### Configuration issues

1. Config file: `~/.claudin/settings.json`
2. `src/platform/config/config.ts` → `getGlobalConfig()` / `saveGlobalConfig()`
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
Grep pattern="from 'src/shared/errors.js'" type="ts"

# Find feature-gated code paths
Grep pattern="feature\('MY_FLAG'\)" type="ts"
```
