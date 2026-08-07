---
name: openclaude is a sibling fork to mine for features
description: openclaude (sibling Claude Code fork) lives at ../openclaude; feature-gap backlog vs claudin, re-audited 2026-08-07 (their v0.27.0 vs claudin v1.1.8)
type: reference
---

`@gitlawb/openclaude` is a sibling fork of Claude Code (same multi-provider retarget as claudin), checked out as a sibling directory at `../openclaude`. Useful to mine for features/fixes when extending claudin — same architecture (openaiShim, providerConfig, withRetry, Ink TUI, slash commands, MCP).

**Why:** Both forks evolve the same upstream independently; openclaude moves fast on providers + context-mgmt and often lands features claudin lacks.

**How to apply:** Cross-check any candidate against claudin's tree first — several things converged independently (claudin already HAS: `/goal`, reasoned-denial permission prompts, per-agent model routing in `/agents`, bypassPermissions mode, 5xx/HTML-overload retry).

## Re-audit 2026-08-07 (their v0.27.0)

Tier 1 to steal, all verified ABSENT in claudin:
- **`src/integrations/`** (123 files, 24k LOC, always-on, no flag) — declarative provider registry. `defineVendor({id, defaultBaseUrl, requiredEnvVars, setup.authMode, transportConfig.openaiShim{thinkingRequestFormat,maxTokensField,removeBodyFields,preserveReasoningContent}, preset, catalog})`; lazy loader, `generated/*.generated.ts`, `integrations:generate|:check` as a CI drift gate. This is the structural answer to what claudin's `/add-provider-preset` skill does by hand (4-6 files per API-key preset, ~16 for OAuth). Canonical example: `src/integrations/vendors/deepseek.ts`.
- **`compressToolHistory` (#1869)** — tiered shrink of old `tool_result` bodies for providers WITHOUT prompt cache (Copilot/Mistral/Ollama), sized off `getEffectiveContextWindowSize()`, idempotent. claudin's stub-rewrite (`stableStubState.ts` → openaiShim) is clip/microcompact-policy-driven, never provider-capability-driven. Feeds roadmap item D3.
- **`src/utils/doomLoop.ts`** — BLOCKS after 3 consecutive identical `(name,input)` calls, state keyed per-agent. claudin only has the advisory hint (`src/services/tools/toolExecution.ts:589`), which counts *failures* and blocks nothing. They already paid for the two refinements: warn-before-stop (#1927), don't trip on same-turn parallel failures (#2048).
- **`src/context/repoMap/`** + RepoMapTool + `/repomap` (~1900 LOC) — claudin has zero `repoMap` matches.

FREE WIN found during this audit: `src/services/api/smartModelRouting.ts` already exists in claudin (215 lines, `routeModel()` at :120) with **zero production importers** — only its own test. It is half of roadmap R1 (cost routing) sitting dead. Wiring it beats porting their `/smartroute` (#1734).

### memdir deep-diff (same audit)

The two `src/memdir/` are near-identical in size (2703 vs 2577 LOC) and share filenames — the delta is behavioral. `findRelevantMemories.ts` and `memoryAge.ts` are **byte-identical** on both sides (Sonnet `sideQuery`, `querySource:'memdir_relevance'`, max 5 picks, no embeddings/recency scoring; neither prunes stale memories). claudin is AHEAD on: project-local team dir + `isTeamMemLikelyGitIgnored` gitignore carve-out (`teamMemPaths.ts:99-132` — openclaude's team dir is still global with no git awareness), the loop-error extraction trigger, and the anti-noise prompt guards.

openclaude is ahead on five things, ranked by port value:
1. **Byte-space truncation — a real claudin bug.** `memdir.ts:35` declares `MAX_ENTRYPOINT_BYTES = 25_000` but `:58` measures `trimmed.length` and `:79` cuts on `truncated.length` — UTF-16 units, not bytes. Non-ASCII `MEMORY.md` overshoots the cap uncut while `wasByteTruncated` reports `false`, and the message still calls it a file size via `formatFileSize()`. openclaude uses `Buffer.byteLength`, cuts with `buf.lastIndexOf(0x0a, …)` and walks back off UTF-8 continuation bytes (`(buf[cutAt]! & 0xc0) === 0x80`). Their `memdir.entrypointBytes.test.ts` (80 lines) pins it; claudin has no equivalent test.
2. **`memoryScan.ts` robustness** (255 vs claudin's 101 lines). claudin does `readdir(recursive:true)` + `Promise.allSettled` over EVERY `.md` at once (unbounded parallel opens), slices to 200 only after reading all, and passes `maxBytes: undefined` (no frontmatter cap). openclaude streams a `walkMarkdownFiles` generator through 8 workers, keeps only the newest 200 via `insertNewestHeader`, caps headers at 64KB, and handles symlinks explicitly.
3. **Auto-memory opt-out evaluated per settings source.** `paths.ts:54-56` reads the MERGED `getInitialSettings()`, so a project-scope `false` is re-enablable by a narrower-scope `true`; openclaude evaluates raw per-source so any `false` wins (#1326).
4. **`src/utils/governancePolicy.ts` (#1806)** — `isMemoryWriteApprovalRequired()` across all sources, defaulting to REQUIRE approval; same file carries `git.addAICoAuthor`/`git.addGeneratedWithFooter` blocks and forbidden commit-message patterns. No claudin counterpart.
5. **Extraction supersede-abort** — `MEMORY_EXTRACTION_SUPERSEDED_ABORT_REASON` + `activeExtractionAbortController`, with a test.

DANGLING REQUIRE in claudin, found here: `src/memdir/findRelevantMemories.ts:66-71` does `require('./memoryShapeTelemetry.js')` for a file that **does not exist in claudin's tree** (openclaude has it, as an inert stub). Safe only because `MEMORY_SHAPE_TELEMETRY` is absent from `scripts/build.ts` and folds false via the `?? false` default — adding that flag as `true` would break at runtime. Either drop the block or add the flag explicitly as false.

Tier 2 (real gaps, medium effort): providerFallbackChain + credential pool (still open since June); `compactModel`; cross-process credential-refresh mutex (#2093 — claudin's `lockfile.lock()` covers only the Anthropic path at `src/utils/auth.ts:1504`, NOT Codex/Copilot/xAI, so this is bug-shaped); `/replay` timeline + deterministic task report (#1705/#1802); `/diagnostics` command (claudin captures + attaches LSP diagnostics in `src/services/lsp/passiveFeedback.ts:43` but has no command); statusline `ctx 74K/200K (37%)` (#1967); `/set-context-window` + per-model context_window/max_output_tokens overrides (#1810/#1234); i18n (their mechanism is ~100 lines, the dictionary is the cost).

Tier 3 (cheap): `--yolo` alias (#2097); auto-compact thresholds in `/config`; configurable REPL max-turns (claudin's is `?? Infinity` at `src/query.ts:1440`); `/export` MD/JSON (`export.tsx:60` still forces `.txt`); Codex OAuth manual callback-URL paste for SSH/remote (#1288).

NOW CONVERGED since June, do NOT port: fuzzy edit (`FileEditTool/utils.ts:175`), `/update` + PM detection (`src/cli/update.ts`), multilingual+structural continuation nudge (`src/utils/continuationNudge.ts`), `/wiki` conventions, session `branch` (only the resume-picker grouping is missing), per-agent `maxTurns`.

STILL IGNORE: `grpc/`+`proto/` (deliberately removed here in #22); `daemon/`, `ssh/`, `jobs/`, `environment-runner/`, `self-hosted-runner/` are inert stubs on THEIR side too (13-145 LOC, written to satisfy their typechecker); sponsor providers. `CONTEXT_COLLAPSE`/`HISTORY_SNIP` remain non-revivable in claudin — not a disabled flag but absent source (`src/services/contextCollapse/index.ts` is 5 lines, `snipCompact.ts` is 104 bytes); `HISTORY_SNIP` is not even in claudin's flag map. Flag-map diff worth a separate look: they run `CACHED_MICROCOMPACT`, `MCP_SKILLS`, `BG_SESSIONS`, `VERIFICATION_AGENT` ON.

## Original audit 2026-06-23 (v0.19)

Feature gaps found 2026-06-23 (openclaude HAS, claudin MISSING/PARTIAL) — Tier 1 to port: providerFallbackChain (429→switch provider, PR#1176); credential pool failover for OpenAI-compat keys (#1706); compactModel = cheaper model for compaction (#1629); `/ctx` + token bars in `/cost` (#1610, claudin has `/context` grid only); fuzzy match in FileEditTool (#1561); export to MD/JSON (#1193, claudin `/export` is .txt only); `/update` self-updater w/ PM detection (#1687). Revivable stubs (flag off in claudin): CONTEXT_COLLAPSE span-summarization (#1619), HISTORY_SNIP snip tool (#1407).

Second-batch gaps (verified 2026-06-23): MISSING & worth porting — tool-failure loop guard (stop repeated identical tool failures, persist across successes; PR#1219/#1277); multilingual+structural continuation nudge (claudin's is EN-only `query.ts:1447`, has NO structural detection; reuse phantomLaunchGuard.ts EN+PT-BR pattern; PR#1280); startup safety warning for 3P provider + permissive mode skipping AI classifier (primitives exist: isFirstPartyAnthropicBaseUrl; PR#1260); redacted diagnostic issue report (claudin `/issue` is a disabled stub; PR#1647). Lower-value MISSING: i18n of slash-command descriptions (#1431), JSON-schema non-object root wrap/unwrap (#1261), per-provider env-file (#1668), profile picker modes (#1472). PARTIAL enhancements: /doctor large-context warning not local-model-gated (#1238), disable-thinking per-Ollama-model flag (#1376), cache-break reliability-tier label (#1693, low value).

Already HAS (convergence, do NOT port): dynamic model discovery, Copilot full catalog + Enterprise, keep-thinking-on-resume for reasoning-echo providers, conversation/session persistence, Windows/WSL robustness (grep paths + WSL stdin + raw-mode), eager/deferred tool split (= "system-prompt immediate tools"), /goal, reasoned-denial prompts, per-agent model routing, bypassPermissions, 5xx/HTML-overload retry.

BIG-EFFORT, skip as cherry-pick: detached daemon background SESSIONS (#1642) — needs reviving DAEMON/BG_SESSIONS flags, source not mirrored.

IGNORE: openclaude's sponsor providers (Xiaomi MiMo, Atlas Cloud, Fireworks, NEAR AI, OpenGateway/Gitlawb, OpenCode Zen/Go); their `/bughunter` (claudin keeps it a deliberate disabled stub); their ~50-commit zero-tsc-errors cleanup (claudin baseline ~4320, cosmetic).
