---
name: openclaude is a sibling fork to mine for features
description: openclaude (sibling Claude Code fork) at ../openclaude; the value is their fix( stream over inherited code — 28 claims re-verified empirically 2026-09-10, 17 real / 11 falsified — not their feature list
type: reference
---

`@gitlawb/openclaude` is a sibling fork of Claude Code (same multi-provider retarget as claudin), checked out as a sibling directory at `../openclaude`. Useful to mine for features/fixes when extending claudin — same architecture (openaiShim, providerConfig, withRetry, Ink TUI, slash commands, MCP).

**Why:** Both forks evolve the same upstream independently; openclaude moves fast on providers + context-mgmt and often lands features claudin lacks.

**How to apply:** Cross-check any candidate against claudin's tree first — several things converged independently (claudin already HAS: `/goal`, reasoned-denial permission prompts, per-agent model routing in `/agents`, bypassPermissions mode, 5xx/HTML-overload retry).

## 2026-09-10 audit (their v0.30.0 vs claudin v1.1.x @ 2365c9f6) — the value is BUGS, not features

The feature backlog below is mostly stale or low-value. What actually pays is
their `fix(` stream over **inherited upstream code**: ~369 fix commits, ~120
triaged as inherited-path candidates. The first pass claimed "15 confirmed, all
citations held" — that was a line-number match, **not a verification**. A second
pass the same day re-ran the real regexes and functions, traced every consumer
and folded every `feature()` gate across all 28 claims: **17 real, 11 dead**,
and three of the original top 8 died. Read this verdict block before acting on
any entry in the list below it.

**FALSIFIED — do not open a PR for these** (numbers = the ranked list below):

- **#1 `ENV_VAR_PATTERN` bypass** — the regex quirk is real (`FOO[$(cmd)]=v x`
  → `x`), the bypass is not. `filterRulesByContentsMatchingInput` builds an
  **additive** candidate list (`bashPermissions.ts:710-757`, matched with
  `.some` at `:778`), so candidate #0 is always the original command; stripping
  can only widen deny matching. Independently `COMMAND_SUBSTITUTION_PATTERNS`
  (`bashSecurity.ts:16-31`) tests `/\$\(/` against the UNSTRIPPED command
  (`bashPermissions.ts:1911,1996`) and forces `ask`. Residual: the subscript
  form defeats `shouldUseSandbox.ts:99`'s `BINARY_HIJACK_VARS` (`PATH[0]` vs
  `/PATH$/`), which `bashPermissions.ts:609` documents as not a boundary.
- **#4 autocompact breaker** — does NOT latch.
  `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`autoCompact.ts:81`), reset on
  success (`:409`, `query.ts:577`), and the counter lives in
  `State.autoCompactTracking` initialized per `queryLoop` (`query.ts:313`) — one
  user turn, not the session. Esc ends the turn, so the abort-counts-as-failure
  wart is inert.
- **#8 stream abort** — `OpenAIShimStream.controller` is an identity TAG
  (`streamParser.ts:15-17,706`). Real cancellation is `sdkSignal`
  (`claude/streaming.ts:1206,1258`) → every fetch in `messagesClient.ts`
  (`:285,331,646,887`) → the parser's abort listener (`streamParser.ts:195`);
  the generator's `return()` also reaches `finally { reader.releaseLock() }`
  (`:645`). Esc does stop OpenAI-compat/Codex streams.
- **#6 write-path `expandPath`** — `matchingRuleForInput` expands internally
  (`filesystem.ts:981`) and `backfillObservableInput` already absolutized the
  path before the decision (`toolExecution.ts:969-978`). Residual: symlink
  *target* enumeration for `NotebookEditTool` alone (the one write tool with no
  backfill) — and it wrongly ALLOWS, not denies.
- **#11 sandbox-toggle dropdown** — the throw is real (`SandboxManager` is the
  build stub, `build.ts:413,430`), but the same stub makes `isSupportedPlatform()`
  null, so `isHidden` is true and `commandSuggestions.ts:36` filters the command
  out BEFORE reading `description` at `:42`. Unreachable in the shipped bundle.
- **#15 argvPreparse** — dead code: `runSshArgvStash` returns at `:127` on
  `!feature('SSH_REMOTE')` and `SSH_REMOTE` is absent from `build.ts`
  featureFlags. Also not a security control — `:143` re-applies the very flag
  the user typed.
- **Unranked, falsified (5 of 12):** `commandSemantics.ts:98` (no doom-loop
  consumer exists here — only the advisory hint at `toolExecution.ts:589`, which
  blocks nothing); `openaiErrorClassification.ts:323` (misclassification is real
  but `retryable` is read only by two `logForDebugging` lines —
  `withRetry.ts:951` retries on `error.status >= 500`, so 5xx HTML DOES retry;
  only the user-facing hint and the debug log lie); `effort.ts:75` (opt-in escape
  hatch working as named — moving it below the exclusion block defeats its
  purpose); `settings.ts:445-505` (`writeFileSyncAndFlush` IS atomic —
  tmp+flush+rename at `shared/fs/file.ts:355-443`; only the unlocked
  read-modify-write is real, and it is last-writer-wins, not corruption);
  `App.tsx:338` (`rawModeEnabledCount` is unclamped but every path is balanced
  and the field is per-instance, so a remount clears it).

**CORRECTED — `BashTool.tsx:1030` timeout: the claim is INVERTED.** PowerShell
CLAMPS (`PowerShellTool.tsx:660`, `Math.min(…, getMaxTimeoutMs())`); **Bash does
not**, and the schema advertises the cap in prose only (`BashTool.tsx:219`), so a
model-supplied `timeout: 86400000` runs unclamped on the Bash path.

**CONFIRMED real and reachable — re-ranked by what the fix buys:**

1. **#2 nested heredoc** (`bashSecurity.ts:521-578`) — the only genuine security
   fail-open in the set. Verbatim run: `echo $(cat <<'A' … $(cat <<'B' … ) … ) ;
   rm -rf /tmp/x` reduces to `"echo "`. LIVE in the shipped bundle: the sole call
   site `bashPermissions.ts:2007` is gated on `astSubcommands === null`, and both
   `TREE_SITTER_BASH*` flags are absent from `build.ts`, so `parseCommandRaw`
   always returns null and the legacy gate is the ONLY gate. Fix = the
   nested-range rejection already written in `isSafeHeredoc:450-457`.
2. **`toolValidationConfig.ts:101` `__proto__`** — worse than filed: the
   TypeError propagates to `parseSettingsFileUncached` (`settings.ts:222,232`),
   which swallows it and returns `{settings:null}`, so ONE `"__proto__(x)"` rule
   silently voids the entire settings file, deny rules included, with no
   diagnostic. `Object.hasOwn` fixes it. `constructor`/`toString` are blocked by
   the uppercase gate at `:138`; `__proto__` is the live one.
3. **`system.ts:75-98` attribution block** — spread into the system prompt at
   `claude/streaming.ts:669` with NO provider gate, kept as block 0 by
   `api.ts:401` and joined into the third-party wire body by
   `openaiShim/messageConverter.ts:87-100`. Leaks
   `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…` to every 3P
   provider, ON by default — directly contradicts AGENTS.md's "one lane only".
   Careful: block 0 is the prompt-cache byte anchor.
4. **#14 `argumentSubstitution.ts:123,140`** — confirmed by running the call
   shape: `$&` re-inserted the matched `$ARGUMENTS` text and `` $` `` spliced in
   the preceding content. Live on every slash command, skill and hook
   (`loadSkillsDir.ts:349`, `loadPluginCommands.ts:332`, `hookHelpers.ts:40`)
   with no test pinning it; the indexed forms at `:128,134` already use function
   replacers — copy them.
5. **#7 worktree baseRef** — `AgentTool.tsx:592` → `createAgentWorktree(slug)` →
   `getOrCreateWorktree` passes NO baseRef and the setting is global-only
   (`settings/types.ts:426-432`), so every `isolation:"worktree"` sub-agent
   audits `origin/<default>`. Root cause of agent-safety.md §2.
6. **#9 marketplace hostPattern** — unanchored `new RegExp` + `.test`
   (`marketplaceHelpers.ts:288`); `doesSourceMatchPathPattern` (`:315`) has the
   same flaw. It IS an admin allowlist (policy settings, documented at `:478`).
7. **#5 context-window pin** — reproduced: with
   `CLAUDIN_OPENAI_CONTEXT_WINDOWS='{"gpt-4o":999999}'` and discovery at 32000
   the resolver returns 32000. Only bites providers that emit `context_length`
   (OpenRouter-class); OpenAI/DeepSeek/Azure populate nothing.
8. **#13 `useTextInput.ts:542-560`** — verified that one read really carries
   `"abc\x7f"` as a SINGLE key with `key.backspace === false`, so the early
   `return` at `:559` drops "abc".
9. **`gitDiff.ts:305-316`** — threshold is THREE chars: a removed line whose
   content starts with `--` (so the line is `---…`) is dropped; a single `-`/`+`
   survives. Feeds `/diff`, `gitLog.ts:195,238`, `GitTool/parsers/diff.ts:254`.
10. **`fetchCapabilities.ts:110,376,410`** — zero occurrences of `cursor` in the
    file and no loop; page 2+ is lost against a paginating MCP server.
11. **#12 persist-before-throw** — `BashTool.tsx:794` throws inside the `try`
    while the persist block sits at `:804-829`, after the `finally`. Identical
    structure in `PowerShellTool.tsx:558-574` — fix both files.
12. **`BashTool.tsx:1030` unclamped timeout** — see CORRECTED above.
13. **`FileEditTool/utils.ts:522`** — real (`oldStart` with new-file content,
    measured off by exactly the insertion delta), but the surface is NOT the edit
    snippet: the sole caller is `agent/attachments/changedFile.ts:80`, the
    model-facing "file changed externally" attachment.
14. **#3 `hydrateRemoteSession`** — real unrecoverable truncation, narrow reach:
    `getSessionLogs` returns null on failure and `|| []` at `:1114` turns that
    into an empty overwrite at `:1125`; needs headless `-p --resume <URL>` AND
    `ENABLE_SESSION_PERSISTENCE` (nothing in the repo sets it). CCR-v2 twin
    `:1149-1177` blocks null at `:1165` but still writes `[]`.
15. **#10 memory prefix** — real (`/work/myapp` loads `/work/myapp-backend`'s
    CLAUDE.md as nested memory), but bounded by `pathInAllowedWorkingPath`
    (`memory.ts:149`), which is itself correct — the sibling must already be an
    added working dir.
16. **`frontmatterParser.ts:242`** — nested brace globs emit a stray `}` and
    match nothing; no shipped `.claudin/rules/` file uses them, but the parser
    also serves `loadSkillsDir.ts:164` and `ruleFrontmatter.ts:60`.
17. **`modelCost.ts:198`** — one `/\bglm/i` row for every GLM tier (Flash billed
    as paid, Air over-billed ~2.5× on input, flat `promptCacheReadTokens: 0.50`
    ignores Z.ai's ~80-90% cache discount). NOT GLM-specific though —
    deepseek/qwen/minimax/moonshot are equally single-row and the table declares
    itself a 2026-04 snapshot (`:140-153`). Minor, display-only.

The original ranked list follows, kept for its citations. Ranked:

1. `src/tools/BashTool/bashPermissions.ts:664` — `ENV_VAR_PATTERN`'s subscript
   class `\[[^\]]*\]` accepts `$(…)`, so `FOO[$(cmd)]=v harmless` strips as an
   env prefix and only `harmless` reaches the deny check. Their `4a98a4a2`;
   fix = narrow the class to `[^\]$\`{(]*`. **Security.**
2. `src/tools/BashTool/bashSecurity.ts:572` — `stripSafeHeredocSubstitutions`
   strips ranges in reverse without rejecting NESTED ranges (`isSafeHeredoc`
   does reject them), so text after the outer heredoc is dropped before
   downstream validators see it. Their `ebc9c70b`. **Security.**
3. `src/sessions/persistence/project.ts:1124` — `hydrateRemoteSession` writes
   `remoteLogs` unconditionally; `|| []` at `:1114` means an empty/failed remote
   response TRUNCATES the local transcript. CCR v2 twin at `:1177`. Their
   `d834904e`. **Data loss, unrecoverable.**
4. `src/agent/compact/autoCompact.ts:335-339` — the autocompact circuit breaker
   latches forever (no cooldown, no half-open) and a user Esc counts as a
   failure; `src/agent/query.ts:716` turns it into a hard "start a new session".
   Their `11d59ecd`.
5. `src/providers/model/openaiContextWindows.ts:482-489` — discovery wins over
   the user's explicit `CLAUDIN_OPENAI_CONTEXT_WINDOWS` pin (`:413`), because
   both the env override and the hardcoded fallback table sit behind ONE
   `lookupByModel` AFTER the discovery return. The comment at `:476-481` argues
   discovery-over-*table*, which is right; discovery-over-*user pin* is the bug.
   Their `3451187a`.
6. `src/permissions/filesystem.ts:1242` — write-permission check matches rules
   against the raw `tool.getPath(input)`; the read path already calls
   `expandPath` (`:1066`). Misfires when session cwd ≠ process cwd (worktree
   agents). Their `4f971a13`.
7. `src/vcs/git/worktree.ts:322` — `worktree.baseRef` defaults to `'fresh'` =
   `origin/<default>`, so `isolation:"worktree"` sub-agents audit a stale base.
   This is the ROOT CAUSE of the hazard `.claudin/rules/agent-safety.md` §2
   documents a manual workaround for. claudin already HAS the `'head'` knob —
   the fix is to default agent-isolation worktrees to it. Their `3fb718f4`.
8. `src/providers/shims/openaiShim/streamParser.ts:706,714` — the stream's
   `AbortController` is never wired to the SSE reader (the generator is
   pre-built), so `stream.controller.abort()` at
   `src/providers/shims/claude/streaming.ts:2389` cancels nothing. Every
   OpenAI-compat/Codex user who presses Esc. Their `bb61d843`.
9. `src/plugins/marketplaceHelpers.ts:288` — `new RegExp(pattern.hostPattern)`
   unanchored, so a managed-settings `strictKnownMarketplaces` entry written as
   `github\.corp\.com` also matches `github.corp.com.evil.io`. Their `5f1ab9b8`.
10. `src/agent/attachments/memory.ts:50` — `currentDir.startsWith(originalCwd)`
    is a string-prefix test, so cwd `/work/myapp` loads `/work/myapp-backend`'s
    CLAUDE.md/AGENTS.md as project memory. Their `0ff1d1cb`.
11. `src/commands/sandbox-toggle/index.ts:12` derefs a possibly-null
    `checkDependencies()`; `src/terminal/suggestions/commandSuggestions.ts:42`
    reads every command's `description` unguarded → one throw kills the WHOLE
    slash-command dropdown. Their `00ff6de4`.
12. `src/tools/BashTool/BashTool.tsx:794` — the non-zero-exit `throw` precedes
    the rolled-output persist, so a failing large command loses its output file
    path. Their `0c9b8149`.
13. `src/terminal/hooks/useTextInput.ts:542-559` — DEL-coalesced chunk applies
    the deletions and `return`s, discarding the text in the same read (SSH/tmux).
    Their `1bf8076d`.
14. `src/commands/argumentSubstitution.ts:123,140` — slash-command args are the
    *replacement operand* of `replace`, so `$$`/`$&`/`` $` ``/`$n` in user text
    are interpreted. Their `62d15d40`.
15. `src/platform/main/argvPreparse.ts:141` — single `indexOf`+`splice` strips
    only the FIRST `--dangerously-skip-permissions` on the `ssh` path. Their
    `787f2a93`.

Also listed, unranked — 7 of these 12 confirmed, 5 falsified (verdicts above):
`src/vcs/git/gitDiff.ts:305` (hunk lines starting
`--`/`++` dropped), `src/tools/FileEditTool/utils.ts:522` (snippet hunks
numbered from the OLD file), `src/providers/shims/openaiErrorClassification.ts:323`
(5xx HTML overload = non-retryable), `src/platform/settings/toolValidationConfig.ts:101`
(`__proto__`-named permission rule aborts validation, `Object.hasOwn` fixes it),
`src/shared/frontmatterParser.ts:242` (nested brace globs in `paths:`),
`src/tools/BashTool/BashTool.tsx:1030` (`timeout` unclamped vs PowerShell),
`src/tools/BashTool/commandSemantics.ts:98` (linter exit 1 = error → retry loop),
`src/terminal/ink/components/App.tsx:338` (`rawModeEnabledCount` no `<=0` clamp),
`src/mcp/client/fetchCapabilities.ts:110,376,410` (MCP list pagination
`nextCursor` never sent → page 2+ dropped), `src/providers/effort/effort.ts:75`
(`CLAUDIN_ALWAYS_ENABLE_EFFORT` returns before the model-exclusion block),
`src/agent/prompts/system.ts:75-98` (Anthropic attribution prompt block
prepended unconditionally — the HTTP headers ARE correctly scoped at
`src/providers/transport/identityHeaders.ts:31-34`, the prompt block is not),
`src/platform/settings/settings.ts:445-505` (settings read-merge-write with no
lock and no atomic rename).

**Their v0.28→v0.30 features are near-worthless to us.** 38 commits: 9 sponsor
providers, 3 docs, 3 release-bot. The only real one is `09eba26d` custom
`modelPricing` per model (claudin's `src/providers/usage/modelCost.ts:154-217`
prices every GLM at one flat regex rate). `c461a036` (knowledge graph +
conversation arc into memdir) is a TRAP: it flips `CONVERSATION_ARC` +
`MULTI_TURN_CONTEXT` ON for everyone, adds Orama as a runtime dep and a regex
fact-scraper that writes conversation content to disk — and three days later
`31ac8a6e` had to retract part of it because the arc block emitted
`Duration: Ns ago` + running token totals into the system prompt, rewriting the
cached prefix EVERY request. claudin's copy of the arc
(`src/agent/context/conversationArc.ts`) is dead because the flag is absent from
`scripts/build/build.ts` and folds false — that deadness is currently a feature.

**Their 8 "extra" top-level dirs are a LAYOUT ARTIFACT, not a feature gap.** All
8 exist in claudin under feature slices: `vim/` identical LOC, `bootstrap/state.ts`
and `upstreamproxy/` near-identical, claudin's `coordinator/` is 29× bigger, and
`bridge/` is 12.8k LOC of DEAD code there (`BRIDGE_MODE:false`) while claudin
ships it flag-ON. Only real gaps: `/lsp` (827 LOC command; claudin has the LSP
*tool* but no command) and buddy's tool-call reaction layer.

### Corrections to the sections below (verified 2026-09-10)

- **memdir byte-truncation "bug" is FIXED in claudin** — `src/memory/memdir/memdir.ts:67,88,92,97-99`
  uses `Buffer.byteLength` + newline-boundary + continuation-byte walk, and
  `memdir.entrypointBytes.test.ts` exists. Strike it.
- **The "DANGLING REQUIRE" is NOT a bug** — `memoryShapeTelemetry.d.ts` exists,
  the specifier is relative so `build.ts` stubs it, and the flag folds false.
  It is the fork's sanctioned missing-module shape. Strike it.
- **`isLocalProviderUrl` is NOT display-only** — 5 behavioral call sites
  (`providerValidation.ts:127`, `providerConfig.ts:395,446`,
  `messagesClient.ts:396,402,413`). Only the fast-path TRIAD is missing.
- **doomLoop's refinements are in a different file** — `#1927`/`#2048` live in
  their `src/query/toolFailureLoopGuard.ts`, not `doomLoop.ts` (104 lines).
- **The credential-mutex gap is NOT a port** — openclaude locks the same two
  lanes claudin does (Anthropic + MCP) and races on Codex/Copilot/xAI
  identically. It is an ORIGINAL fix if we want it.
- **`integrations:check` is not a CI gate** — the drift check is a unit test,
  `integrations/artifactGenerator.test.ts:69`. The registry IS real though: 146
  files / 35.9k LOC / 14 vendors / 41 non-test importers, and it mutates the
  wire body at `openaiShim/requestPreparation.ts:186-318`.
- `smartModelRouting.ts` dead-code claim CONFIRMED — `routeModel()` at `:120`,
  sole importer is its own test.

## Structural divergence measured 2026-08-14 (their v0.28.0 vs claudin v1.1.12)

Hash-diff of the two `src/` trees (claudin 3366 files, openclaude 3125): only
**209** files are byte-identical at the same path, and **283** claudin files have
their exact bytes anywhere in their tree (74 of those only at a *different* path —
claudin's `src/utils` → `src/services/*` reorg). Of the 1657 shared paths, 1448
differ; normalizing away the import-path convention (**claudin `from 'src/…'`,
openclaude `from '../…'` — this alone accounts for most of the 130 one-to-two-line
diffs**) makes another 327 identical, so ~536/1657 = 32% of shared paths are
effectively the same file. The rest: 219 differ by ≤4 lines, 336 by 21-100, 250 by
100+. Most divergent shared files: `cli/print.ts` (5569), `main.tsx` (4518),
`screens/REPL.tsx` (3688), `services/api/claude.ts` (3604), `services/mcp/client.ts`
(3425), `components/ProviderManager.tsx` (3312).

**How to apply:** do NOT expect a cherry-pick or `git apply` to work across the two
trees — the import convention differs on nearly every file and 511 of the
exclusive-path files are the same basename moved *and* edited. Port by reading and
rewriting, which is what every audit above already assumed.

Inventory delta at that date — tools: 52 shared, claudin-only `AgentWorkflow
ApplyPatchTool BuildTool ConfigTool GitTool RenameTool ReportFindingsTool
RunTestsTool ScheduleWakeupTool TypecheckTool`, openclaude-only `CtxInspectTool
RepoMapTool SuggestBackgroundPRTool firecrawl`. Slash commands: 91 shared,
claudin-only `explorer fork`, openclaude-only 22 incl. `lsp diagnostics replay
repomap smartroute set-context-window request-size commit-message pr_comments
update logout chrome mobile tag`. Top-level `src/` dirs: claudin-only `main
moreright outputFilter stubs vendor`; openclaude-only `grpc i18n integrations proto
test`.

## Re-audit 2026-08-07 (their v0.27.0)

Tier 1 to steal, all verified ABSENT in claudin:
- **`src/integrations/`** (123 files, 24k LOC, always-on, no flag) — declarative provider registry. `defineVendor({id, defaultBaseUrl, requiredEnvVars, setup.authMode, transportConfig.openaiShim{thinkingRequestFormat,maxTokensField,removeBodyFields,preserveReasoningContent}, preset, catalog})`; lazy loader, `generated/*.generated.ts`, `integrations:generate|:check` as a CI drift gate. This is the structural answer to what claudin's `/add-provider-preset` skill does by hand (4-6 files per API-key preset, ~16 for OAuth). Canonical example: `src/integrations/vendors/deepseek.ts`.
- **`compressToolHistory` (#1869)** — tiered shrink of old `tool_result` bodies for providers WITHOUT prompt cache (Copilot/Mistral/Ollama), sized off `getEffectiveContextWindowSize()`, idempotent. claudin's stub-rewrite (`stableStubState.ts` → openaiShim) is clip/microcompact-policy-driven, never provider-capability-driven. Feeds roadmap item D3.
- **`src/utils/doomLoop.ts`** — BLOCKS after 3 consecutive identical `(name,input)` calls, state keyed per-agent. claudin only has the advisory hint (`src/agent/tools/toolExecution.ts:589`), which counts *failures* and blocks nothing. They already paid for the two refinements: warn-before-stop (#1927), don't trip on same-turn parallel failures (#2048).
- ~~**`src/terminal/contexts/repoMap/`** + RepoMapTool + `/repomap`~~ — **REJECTED with data 2026-08-07**, see [[repo-map-rejected-orientation-measured]]. Also worth knowing before reconsidering: it is ~1150 prod LOC (not the ~1900 first cited, which counted its 1734 LOC of tests), and it is probably non-functional in their published package — its five runtime deps sit in `devDependencies` and `scripts/build/build.ts` vendors no `.wasm`, so `loadLanguage` returns null and the map comes out empty in silence. `RepoMapTool` is still registered unconditionally (`tools.ts:192`) despite `REPO_MAP: false`, costing ~1.4 KB of prompt for a disabled feature.

FREE WIN found during this audit: `src/providers/routing/smartModelRouting.ts` already exists in claudin (215 lines, `routeModel()` at :120) with **zero production importers** — only its own test. It is half of roadmap R1 (cost routing) sitting dead. Wiring it beats porting their `/smartroute` (#1734).

### memdir deep-diff (same audit)

### cache/perf diff (2026-08-07, separate pass)

Ranked, all verified absent in claudin:
1. **Local-provider fast path** — `getLocalFastPathConfig()` at their
   `services/api/providerConfig.ts:600-640` (`OPENCLAUDE_LOCAL_FAST_PATH`, else
   `isLocalProviderUrl` decides) turns off three per-request costs for
   loopback/RFC1918/`.local` endpoints: `skipStableStringify`,
   `skipStrictTools`, `skipToolHistoryCompression`; consumed at
   `openaiShim.ts:853,1025,1063`. claudin HAS `isLocalProviderUrl` but uses it
   only for display (`components/StartupScreen.ts:81,108`). Effort S, real win
   for Ollama/vLLM, and cache-invariant-safe (local endpoints have no prompt
   cache; the toggles only remove work).
2. **`compressToolHistory` — port the GATE, not the rewriter.** claudin deleted
   its copy in `f4ac9281` in favour of the unified stable-stub path. What is
   genuinely missing is the *trigger*: their `claude.ts:1399-1413`
   `shouldCompressNativeToolHistory({apiProvider, isFirstPartyBaseUrl,
   isGithubNativeAnthropic, hasProviderOverride, promptCachingEnabled})`
   compresses native traffic **only when prompt caching is inactive**. claudin's
   `applyStableStubs`/`stableStubState.ts` is clip/microcompact-policy-driven
   with no provider-capability arm. Their own comment (`claude.ts:1389-1395`)
   restates claudin's clip-frontier invariant, so keep stable-stub as the
   rewriter and add only the predicate.
3. **`contextCollapse` + `snipCompact` are REAL code there** (2,360 LOC over 12
   files + `snipCompact.ts` 281) where claudin has 148-byte and 104-byte stubs —
   so it is a transplant, not a flag flip. Effort L, invariant-risky.
4. `conversationCache.ts` (LRU/TTL 24h) — low value, claudin's
   `tools/shared/twoTierCache.ts` is a better primitive.

claudin is AHEAD, do NOT port: `addCacheBreakpoints` (they pin the marker at
`messages.length-1`, `claude.ts:3448`; claudin defers it via `clipFrontierIndex`
at `claude/paramBuilders.ts:319`); the whole `src/agent/cache/` tree and
`toolResultCache.ts`/`cacheInvalidation.ts`, which have **no counterpart there**;
`fileStateCache.ts` (395 vs 142 lines); `modelCache.ts`, `mcp/client/authCache.ts`.
**`CACHED_MICROCOMPACT` being ON in their flag map buys them nothing** —
`compact/cachedMicrocompact.ts:1` is literally "Stub — not included in source
snapshot". `memoize.ts` and the v8 compile cache are identical on both sides.

Claudin's own per-turn scan findings from the same day are in
[[per-turn-fs-scan-audit]].

The two `src/memory/memdir/` are near-identical in size (2703 vs 2577 LOC) and share filenames — the delta is behavioral. `findRelevantMemories.ts` and `memoryAge.ts` are **byte-identical** on both sides (Sonnet `sideQuery`, `querySource:'memdir_relevance'`, max 5 picks, no embeddings/recency scoring; neither prunes stale memories). claudin is AHEAD on: project-local team dir + `isTeamMemLikelyGitIgnored` gitignore carve-out (`teamMemPaths.ts:99-132` — openclaude's team dir is still global with no git awareness), the loop-error extraction trigger, and the anti-noise prompt guards.

openclaude is ahead on five things, ranked by port value:
1. **Byte-space truncation — a real claudin bug.** `memdir.ts:35` declares `MAX_ENTRYPOINT_BYTES = 25_000` but `:58` measures `trimmed.length` and `:79` cuts on `truncated.length` — UTF-16 units, not bytes. Non-ASCII `MEMORY.md` overshoots the cap uncut while `wasByteTruncated` reports `false`, and the message still calls it a file size via `formatFileSize()`. openclaude uses `Buffer.byteLength`, cuts with `buf.lastIndexOf(0x0a, …)` and walks back off UTF-8 continuation bytes (`(buf[cutAt]! & 0xc0) === 0x80`). Their `memdir.entrypointBytes.test.ts` (80 lines) pins it; claudin has no equivalent test.
2. **`memoryScan.ts` robustness** (255 vs claudin's 101 lines). claudin does `readdir(recursive:true)` + `Promise.allSettled` over EVERY `.md` at once (unbounded parallel opens), slices to 200 only after reading all, and passes `maxBytes: undefined` (no frontmatter cap). openclaude streams a `walkMarkdownFiles` generator through 8 workers, keeps only the newest 200 via `insertNewestHeader`, caps headers at 64KB, and handles symlinks explicitly.
3. **Auto-memory opt-out evaluated per settings source.** `paths.ts:54-56` reads the MERGED `getInitialSettings()`, so a project-scope `false` is re-enablable by a narrower-scope `true`; openclaude evaluates raw per-source so any `false` wins (#1326).
4. **`src/utils/governancePolicy.ts` (#1806)** — `isMemoryWriteApprovalRequired()` across all sources, defaulting to REQUIRE approval; same file carries `git.addAICoAuthor`/`git.addGeneratedWithFooter` blocks and forbidden commit-message patterns. No claudin counterpart.
5. **Extraction supersede-abort** — `MEMORY_EXTRACTION_SUPERSEDED_ABORT_REASON` + `activeExtractionAbortController`, with a test.

DANGLING REQUIRE in claudin, found here: `src/memory/memdir/findRelevantMemories.ts:66-71` does `require('./memoryShapeTelemetry.js')` for a file that **does not exist in claudin's tree** (openclaude has it, as an inert stub). Safe only because `MEMORY_SHAPE_TELEMETRY` is absent from `scripts/build/build.ts` and folds false via the `?? false` default — adding that flag as `true` would break at runtime. Either drop the block or add the flag explicitly as false.

Tier 2 (real gaps, medium effort): providerFallbackChain + credential pool (still open since June); `compactModel`; cross-process credential-refresh mutex (#2093 — claudin's `lockfile.lock()` covers only the Anthropic path at `src/providers/auth/auth.ts:1504`, NOT Codex/Copilot/xAI, so this is bug-shaped); `/replay` timeline + deterministic task report (#1705/#1802); `/diagnostics` command (claudin captures + attaches LSP diagnostics in `src/platform/lsp/passiveFeedback.ts:43` but has no command); statusline `ctx 74K/200K (37%)` (#1967); `/set-context-window` + per-model context_window/max_output_tokens overrides (#1810/#1234); i18n (their mechanism is ~100 lines, the dictionary is the cost).

Tier 3 (cheap): `--yolo` alias (#2097); auto-compact thresholds in `/config`; configurable REPL max-turns (claudin's is `?? Infinity` at `src/agent/query.ts:1440`); `/export` MD/JSON (`export.tsx:60` still forces `.txt`); Codex OAuth manual callback-URL paste for SSH/remote (#1288).

NOW CONVERGED since June, do NOT port: fuzzy edit (`FileEditTool/utils.ts:175`), `/update` + PM detection (`src/platform/headless/update.ts`), multilingual+structural continuation nudge (`src/agent/continuationNudge.ts`), `/wiki` conventions, session `branch` (only the resume-picker grouping is missing), per-agent `maxTurns`.

STILL IGNORE: `grpc/`+`proto/` (deliberately removed here in #22); `daemon/`, `ssh/`, `jobs/`, `environment-runner/`, `self-hosted-runner/` are inert stubs on THEIR side too (13-145 LOC, written to satisfy their typechecker); sponsor providers. `CONTEXT_COLLAPSE`/`HISTORY_SNIP` remain non-revivable in claudin — not a disabled flag but absent source (`src/agent/contextCollapse/index.ts` is 5 lines, `snipCompact.ts` is 104 bytes); `HISTORY_SNIP` is not even in claudin's flag map. Flag-map diff worth a separate look: they run `CACHED_MICROCOMPACT`, `MCP_SKILLS`, `BG_SESSIONS`, `VERIFICATION_AGENT` ON.

## Original audit 2026-06-23 (v0.19)

Feature gaps found 2026-06-23 (openclaude HAS, claudin MISSING/PARTIAL) — Tier 1 to port: providerFallbackChain (429→switch provider, PR#1176); credential pool failover for OpenAI-compat keys (#1706); compactModel = cheaper model for compaction (#1629); `/ctx` + token bars in `/cost` (#1610, claudin has `/context` grid only); fuzzy match in FileEditTool (#1561); export to MD/JSON (#1193, claudin `/export` is .txt only); `/update` self-updater w/ PM detection (#1687). Revivable stubs (flag off in claudin): CONTEXT_COLLAPSE span-summarization (#1619), HISTORY_SNIP snip tool (#1407).

Second-batch gaps (verified 2026-06-23): MISSING & worth porting — tool-failure loop guard (stop repeated identical tool failures, persist across successes; PR#1219/#1277); multilingual+structural continuation nudge (claudin's is EN-only `query.ts:1447`, has NO structural detection; reuse phantomLaunchGuard.ts EN+PT-BR pattern; PR#1280); startup safety warning for 3P provider + permissive mode skipping AI classifier (primitives exist: isFirstPartyAnthropicBaseUrl; PR#1260); redacted diagnostic issue report (claudin `/issue` is a disabled stub; PR#1647). Lower-value MISSING: i18n of slash-command descriptions (#1431), JSON-schema non-object root wrap/unwrap (#1261), per-provider env-file (#1668), profile picker modes (#1472). PARTIAL enhancements: /doctor large-context warning not local-model-gated (#1238), disable-thinking per-Ollama-model flag (#1376), cache-break reliability-tier label (#1693, low value).

Already HAS (convergence, do NOT port): dynamic model discovery, Copilot full catalog + Enterprise, keep-thinking-on-resume for reasoning-echo providers, conversation/session persistence, Windows/WSL robustness (grep paths + WSL stdin + raw-mode), eager/deferred tool split (= "system-prompt immediate tools"), /goal, reasoned-denial prompts, per-agent model routing, bypassPermissions, 5xx/HTML-overload retry.

BIG-EFFORT, skip as cherry-pick: detached daemon background SESSIONS (#1642) — needs reviving DAEMON/BG_SESSIONS flags, source not mirrored.

IGNORE: openclaude's sponsor providers (Xiaomi MiMo, Atlas Cloud, Fireworks, NEAR AI, OpenGateway/Gitlawb, OpenCode Zen/Go); their `/bughunter` (claudin keeps it a deliberate disabled stub); their ~50-commit zero-tsc-errors cleanup — claudin reached zero independently on 2026-08-13, so nothing here is left to port, and the "claudin baseline ~4320, cosmetic" dismissal this line used to carry is doubly out of date (see [[typecheck-backlog-shape]]).
