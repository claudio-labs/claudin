---
name: openclaude is a sibling fork to mine for features
description: openclaude (sibling Claude Code fork) lives at ../openclaude; feature-gap backlog vs claudin plus the measured structural divergence (2026-08-14, their v0.28.0 vs claudin v1.1.12)
type: reference
---

`@gitlawb/openclaude` is a sibling fork of Claude Code (same multi-provider retarget as claudin), checked out as a sibling directory at `../openclaude`. Useful to mine for features/fixes when extending claudin — same architecture (openaiShim, providerConfig, withRetry, Ink TUI, slash commands, MCP).

**Why:** Both forks evolve the same upstream independently; openclaude moves fast on providers + context-mgmt and often lands features claudin lacks.

**How to apply:** Cross-check any candidate against claudin's tree first — several things converged independently (claudin already HAS: `/goal`, reasoned-denial permission prompts, per-agent model routing in `/agents`, bypassPermissions mode, 5xx/HTML-overload retry).

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
- **`src/utils/doomLoop.ts`** — BLOCKS after 3 consecutive identical `(name,input)` calls, state keyed per-agent. claudin only has the advisory hint (`src/services/tools/toolExecution.ts:589`), which counts *failures* and blocks nothing. They already paid for the two refinements: warn-before-stop (#1927), don't trip on same-turn parallel failures (#2048).
- ~~**`src/context/repoMap/`** + RepoMapTool + `/repomap`~~ — **REJECTED with data 2026-08-07**, see [[repo-map-rejected-orientation-measured]]. Also worth knowing before reconsidering: it is ~1150 prod LOC (not the ~1900 first cited, which counted its 1734 LOC of tests), and it is probably non-functional in their published package — its five runtime deps sit in `devDependencies` and `scripts/build.ts` vendors no `.wasm`, so `loadLanguage` returns null and the map comes out empty in silence. `RepoMapTool` is still registered unconditionally (`tools.ts:192`) despite `REPO_MAP: false`, costing ~1.4 KB of prompt for a disabled feature.

FREE WIN found during this audit: `src/services/api/smartModelRouting.ts` already exists in claudin (215 lines, `routeModel()` at :120) with **zero production importers** — only its own test. It is half of roadmap R1 (cost routing) sitting dead. Wiring it beats porting their `/smartroute` (#1734).

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
at `claude/paramBuilders.ts:319`); the whole `src/services/cache/` tree and
`toolResultCache.ts`/`cacheInvalidation.ts`, which have **no counterpart there**;
`fileStateCache.ts` (395 vs 142 lines); `modelCache.ts`, `mcp/client/authCache.ts`.
**`CACHED_MICROCOMPACT` being ON in their flag map buys them nothing** —
`compact/cachedMicrocompact.ts:1` is literally "Stub — not included in source
snapshot". `memoize.ts` and the v8 compile cache are identical on both sides.

Claudin's own per-turn scan findings from the same day are in
[[per-turn-fs-scan-audit]].

The two `src/memdir/` are near-identical in size (2703 vs 2577 LOC) and share filenames — the delta is behavioral. `findRelevantMemories.ts` and `memoryAge.ts` are **byte-identical** on both sides (Sonnet `sideQuery`, `querySource:'memdir_relevance'`, max 5 picks, no embeddings/recency scoring; neither prunes stale memories). claudin is AHEAD on: project-local team dir + `isTeamMemLikelyGitIgnored` gitignore carve-out (`teamMemPaths.ts:99-132` — openclaude's team dir is still global with no git awareness), the loop-error extraction trigger, and the anti-noise prompt guards.

openclaude is ahead on five things, ranked by port value:
1. **Byte-space truncation — a real claudin bug.** `memdir.ts:35` declares `MAX_ENTRYPOINT_BYTES = 25_000` but `:58` measures `trimmed.length` and `:79` cuts on `truncated.length` — UTF-16 units, not bytes. Non-ASCII `MEMORY.md` overshoots the cap uncut while `wasByteTruncated` reports `false`, and the message still calls it a file size via `formatFileSize()`. openclaude uses `Buffer.byteLength`, cuts with `buf.lastIndexOf(0x0a, …)` and walks back off UTF-8 continuation bytes (`(buf[cutAt]! & 0xc0) === 0x80`). Their `memdir.entrypointBytes.test.ts` (80 lines) pins it; claudin has no equivalent test.
2. **`memoryScan.ts` robustness** (255 vs claudin's 101 lines). claudin does `readdir(recursive:true)` + `Promise.allSettled` over EVERY `.md` at once (unbounded parallel opens), slices to 200 only after reading all, and passes `maxBytes: undefined` (no frontmatter cap). openclaude streams a `walkMarkdownFiles` generator through 8 workers, keeps only the newest 200 via `insertNewestHeader`, caps headers at 64KB, and handles symlinks explicitly.
3. **Auto-memory opt-out evaluated per settings source.** `paths.ts:54-56` reads the MERGED `getInitialSettings()`, so a project-scope `false` is re-enablable by a narrower-scope `true`; openclaude evaluates raw per-source so any `false` wins (#1326).
4. **`src/utils/governancePolicy.ts` (#1806)** — `isMemoryWriteApprovalRequired()` across all sources, defaulting to REQUIRE approval; same file carries `git.addAICoAuthor`/`git.addGeneratedWithFooter` blocks and forbidden commit-message patterns. No claudin counterpart.
5. **Extraction supersede-abort** — `MEMORY_EXTRACTION_SUPERSEDED_ABORT_REASON` + `activeExtractionAbortController`, with a test.

DANGLING REQUIRE in claudin, found here: `src/memdir/findRelevantMemories.ts:66-71` does `require('./memoryShapeTelemetry.js')` for a file that **does not exist in claudin's tree** (openclaude has it, as an inert stub). Safe only because `MEMORY_SHAPE_TELEMETRY` is absent from `scripts/build.ts` and folds false via the `?? false` default — adding that flag as `true` would break at runtime. Either drop the block or add the flag explicitly as false.

Tier 2 (real gaps, medium effort): providerFallbackChain + credential pool (still open since June); `compactModel`; cross-process credential-refresh mutex (#2093 — claudin's `lockfile.lock()` covers only the Anthropic path at `src/services/auth/auth.ts:1504`, NOT Codex/Copilot/xAI, so this is bug-shaped); `/replay` timeline + deterministic task report (#1705/#1802); `/diagnostics` command (claudin captures + attaches LSP diagnostics in `src/services/lsp/passiveFeedback.ts:43` but has no command); statusline `ctx 74K/200K (37%)` (#1967); `/set-context-window` + per-model context_window/max_output_tokens overrides (#1810/#1234); i18n (their mechanism is ~100 lines, the dictionary is the cost).

Tier 3 (cheap): `--yolo` alias (#2097); auto-compact thresholds in `/config`; configurable REPL max-turns (claudin's is `?? Infinity` at `src/query.ts:1440`); `/export` MD/JSON (`export.tsx:60` still forces `.txt`); Codex OAuth manual callback-URL paste for SSH/remote (#1288).

NOW CONVERGED since June, do NOT port: fuzzy edit (`FileEditTool/utils.ts:175`), `/update` + PM detection (`src/cli/update.ts`), multilingual+structural continuation nudge (`src/utils/continuationNudge.ts`), `/wiki` conventions, session `branch` (only the resume-picker grouping is missing), per-agent `maxTurns`.

STILL IGNORE: `grpc/`+`proto/` (deliberately removed here in #22); `daemon/`, `ssh/`, `jobs/`, `environment-runner/`, `self-hosted-runner/` are inert stubs on THEIR side too (13-145 LOC, written to satisfy their typechecker); sponsor providers. `CONTEXT_COLLAPSE`/`HISTORY_SNIP` remain non-revivable in claudin — not a disabled flag but absent source (`src/services/contextCollapse/index.ts` is 5 lines, `snipCompact.ts` is 104 bytes); `HISTORY_SNIP` is not even in claudin's flag map. Flag-map diff worth a separate look: they run `CACHED_MICROCOMPACT`, `MCP_SKILLS`, `BG_SESSIONS`, `VERIFICATION_AGENT` ON.

## Original audit 2026-06-23 (v0.19)

Feature gaps found 2026-06-23 (openclaude HAS, claudin MISSING/PARTIAL) — Tier 1 to port: providerFallbackChain (429→switch provider, PR#1176); credential pool failover for OpenAI-compat keys (#1706); compactModel = cheaper model for compaction (#1629); `/ctx` + token bars in `/cost` (#1610, claudin has `/context` grid only); fuzzy match in FileEditTool (#1561); export to MD/JSON (#1193, claudin `/export` is .txt only); `/update` self-updater w/ PM detection (#1687). Revivable stubs (flag off in claudin): CONTEXT_COLLAPSE span-summarization (#1619), HISTORY_SNIP snip tool (#1407).

Second-batch gaps (verified 2026-06-23): MISSING & worth porting — tool-failure loop guard (stop repeated identical tool failures, persist across successes; PR#1219/#1277); multilingual+structural continuation nudge (claudin's is EN-only `query.ts:1447`, has NO structural detection; reuse phantomLaunchGuard.ts EN+PT-BR pattern; PR#1280); startup safety warning for 3P provider + permissive mode skipping AI classifier (primitives exist: isFirstPartyAnthropicBaseUrl; PR#1260); redacted diagnostic issue report (claudin `/issue` is a disabled stub; PR#1647). Lower-value MISSING: i18n of slash-command descriptions (#1431), JSON-schema non-object root wrap/unwrap (#1261), per-provider env-file (#1668), profile picker modes (#1472). PARTIAL enhancements: /doctor large-context warning not local-model-gated (#1238), disable-thinking per-Ollama-model flag (#1376), cache-break reliability-tier label (#1693, low value).

Already HAS (convergence, do NOT port): dynamic model discovery, Copilot full catalog + Enterprise, keep-thinking-on-resume for reasoning-echo providers, conversation/session persistence, Windows/WSL robustness (grep paths + WSL stdin + raw-mode), eager/deferred tool split (= "system-prompt immediate tools"), /goal, reasoned-denial prompts, per-agent model routing, bypassPermissions, 5xx/HTML-overload retry.

BIG-EFFORT, skip as cherry-pick: detached daemon background SESSIONS (#1642) — needs reviving DAEMON/BG_SESSIONS flags, source not mirrored.

IGNORE: openclaude's sponsor providers (Xiaomi MiMo, Atlas Cloud, Fireworks, NEAR AI, OpenGateway/Gitlawb, OpenCode Zen/Go); their `/bughunter` (claudin keeps it a deliberate disabled stub); their ~50-commit zero-tsc-errors cleanup (claudin baseline ~4320, cosmetic).
