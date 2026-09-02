---
name: Prompt-cache break audit (2026-06-11) — ALL FIXED on fix/cache-break-audit
description: S1/S2/S3/A1/A2/A3 cache-invalidation bugs fixed in 9 commits on fix/cache-break-audit (one per bug + invariant suite + docs + test hygiene); repros inverted into regressions
type: project
---

Audit of spontaneous prompt-cache breaks (2026-06-11). All six confirmed bugs were FIXED the same day on branch `fix/cache-break-audit` (9 commits, one per concern; plan: `~/.claudin/plans/snazzy-yawning-pearl.md`):

- **S3** `58356317` — first-write-wins stub byte registry (`perKeyStubText` in stableStubState.ts): first stub emitted per tool_use_id records exact bytes; every rewriter replays them (fixes preview-vs-original divergence). Regression: `stableStubState.stub-byte-stability.test.ts`.
- **S2** `86ac52c9` — time-based microcompact unified into the stable-stub set (`addClippedIds`, view unchanged, wire rewrite via applyStableStubs); `resetMicrocompactState()` call removed from the time path; `TIME_BASED_MC_CLEARED_MESSAGE` deleted. Regression: `microCompact.timebased-flipback.test.ts`.
- **S1** `efca185f` — eviction amortized: `evictOldStubbedMessages` batch floor `EVICT_MIN_BATCH=24`, `evictToMaxSize` hysteresis `EVICT_TRIGGER_AT=300`→cut to 200, `notifyCacheDeletion` in REPL post-turn, free full sweep pre-query on idle gap (`evaluateTimeBasedTrigger` in onSubmit). Display steady-state up to 300 msgs (accepted trade).
- **A1** `2a9e48fc` — `resolveUpdatedTools` (useManageMCPConnections.ts, exported): positional MCP tool replacement (identical reconnect = byte-identical pool) + schemas kept on `failed` ('disabled' still removes; dead-client calls lazy-reconnect via ensureConnectedClient or error as is_error).
- **A3** `dec14782` — LSP `defer_loading` latches per session (bootstrap/state lspDeferLatchedTools, cleared by clearBetaHeaderLatches on /clear+/compact).
- **A2** `99c7642c` — `tengu_glacier_2xr: true` in `_openBuildDefaults` (delta attachments replace the ephemeral messages[0] prepend) + zero-break upgrade latch `maybeLatchLegacyDeferredAnnouncement` (toolSearch.ts): session resumed with pre-process assistant <60min old stays on legacy format; consumers unified via `isDeferredToolsDeltaActive` (prepend + ToolSearchTool hint + attachment injection).
- **Invariant suite** `d7736da9` — `requestDeterminism.invariant.test.ts`: turn N's full render must be a byte-identical prefix of turn N+1 (cache_control stripped); break-and-restore verified.
- **Test hygiene** `394a6feb` — file.test.ts restored growthbook to `{}` in afterEach, poisoning the module registry for all later test files in full runs (caused 4 of main's pre-existing failures). Full-suite: main 153 fails (pre-existing) → branch 150.

Validation: compact/mcp/api suites green; test:provider 533/533; build+smoke+verify:privacy pass.
Lockstep bench 2026-06-11 (sonnet-4.6, 58 turns / 120 requests, identical pacing): main cost=$4.82 cW=415k r:w=16.2 → branch cost=$4.51 (−6.4%) cW=345k (−17%) r:w=20.2, resets 3→3. Note: the lockstep workload has no idle gaps / >200-msg sessions / MCP reconnects, so it does NOT exercise the fixed worst cases — the win there (idle-gap flip-back, eviction breaks) is on top of this.
Review follow-ups (post-adversarial-review, same day): `41d9f326` A2 latch made format-aware (skips when history has DTD attachments) + settled at the attachments pipeline (was: injector ran before queryModel's latch → both formats in one request); `5dc578fe` S1 idle sweep gated on `!queryGuard.isActive` + append-preserving setMessages; `55c7569d` **isLoggableMessage whitelists deferred_tools_delta for external users** — without it the marker never persisted, every /resume latched legacy AND warm delta resumes could never reproduce the attachment prefix bytes anyway. The latch premise depends on that whitelist (cross-referenced in both files' comments + tests). All verified break-and-restore.
Known WEAK spots (accepted): A3 streaming.ts and S1 REPL.tsx wiring are source-grep-guarded only; S3 registry/clipped-set evict independently at MAX_TRACKED_KEYS=16 (only matters >16 concurrent agents).
Note: `'../../types/message.js'` TS2307 in tests is pre-existing baseline noise (production uses the same import; bun test green).
