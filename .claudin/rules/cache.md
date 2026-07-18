---
paths:
  - "src/services/cache/**"
  - "src/services/api/claude/**"
  - "src/services/tools/toolResultCache.ts"
  - "src/services/tools/cacheInvalidation.ts"
---
# Prompt Cache & Tool-Result Cache — Claudin Development Rules

Architecture: `src/services/cache/README.md` + `docs/tech/cache/clip-frontier-breakpoint.md`.
This rule captures the **invariants** that are easy to break silently — verify
file:line against current code.

## 1. The cross-cutting invariant (never break this)

Any new marker, stub, injection, or attachment MUST sit **behind the clip
frontier** and must not mutate bytes behind the message-level `cache_control`
marker. Formally: **turn N's full render must be a byte-identical prefix of turn
N+1's** (with `cache_control` stripped). A single mutated byte behind the marker
invalidates the whole prefix and silently rebills `cache_creation`.

- Regression guard: `requestDeterminism.invariant.test.ts` (break-and-restore).
- When adding anything to the request, ask "does this change a byte before the
  marker on a later turn?" If yes, it belongs after the frontier or not at all.

## 2. Defer-cache-marker — `Math.max(i, 0)` fallback is load-bearing

`src/services/api/claude/paramBuilders.ts::addCacheBreakpoints` does NOT pin the
single `cache_control` marker at `messages[length-1]` each turn — it walks
backward summing `roughTokenCountEstimationForMessage` and places the marker at
the earliest index whose suffix sums to ≥ `DEFAULT_DEFER_CACHE_MARKER_TOKENS`
(2048). Runtime override: `CLAUDIN_DEFER_CACHE_MARKER=<N>` (0 = baseline).

- **Why:** Anthropic's cache silently discards writes when the trailing block
  between markers is too small (~1024 tok). A per-turn last-message marker makes
  every small tool-loop turn fall below the floor → billed but not stored.
- **DO NOT "simplify" the `Math.max(i, 0)` head-anchor fallback.** Pinning to
  `messages[0]` when the loop exhausts is intentional; an "elegant" fallback to
  `baseMarkerIndex` (length-1) regressed the bench from r:w 10.48 → 0.78. The long
  comment in `paramBuilders.ts` documents this — respect it.
- `skipCacheWrite` bypasses the defer logic (preserved). Tests memoize the
  threshold: call `_resetDeferCacheMarkerForTesting()` after flipping the env
  (`src/services/api/claude/__tests__/addCacheBreakpoints.test.ts`).

## 3. toolResultCache keys omit cwd — invalidate on any chdir

`src/services/tools/toolResultCache.ts` keys entries as
`tool::stableStringify(input)` — **no cwd component**. A relative-path arg maps to
the same key before and after `process.chdir()`, serving a stale hit against the
wrong directory. The Read mtime guard is NOT a backstop; Glob/Grep/LSP have none.

- Any mid-session `process.chdir()` MUST call `invalidateAll()` after the chdir.
  Existing homes: worktree enter/exit (`cacheInvalidation.ts`), `WorktreeExitDialog`
  (`recordWorktreeExit()`), `/resume` slash command (`sessionRestore.ts`).
- **The `/resume` slash command is NOT a session boundary** — it reuses the warm
  process, so it must invalidate. EXEMPT only: true boundaries where the cache is
  still empty (`setup.ts` startup, the `--resume`/`--continue` CLI flag in
  `resume.ts`). Encoding cwd into the key was deliberately NOT done (broad
  semantic change).

## 4. Cache TTL tiers — new query sources default to the expensive 1h

`should1hCacheTTL`/`cacheControl.ts`:
- `agent:*` → 5m (1.25x write) EXCEPT `agent:builtin:fork` (shares the main
  thread's 1h prefix); `SHORT_LIVED_QUERY_SOURCES` (web_search_tool,
  agent_summary, away_summary, hook_prompt, …) → 5m.
- Main-thread / compact / session_memory / speculation / auto_mode → keep 1h
  (they fork the main thread's prefix). `auto_mode` was tried at 5m and REVERTED
  (its classifier caches a session-growing, per-tool-call prefix — a mini main
  thread; >5min pauses would force full rewrites).
- **How to apply:** a new one-shot utility querySource must be added to
  `SHORT_LIVED_QUERY_SOURCES` or it silently pays the 1h tier; anything that
  re-sends the main thread's prefix must NOT be added.
- Slim-subagent: `omitClaudeMdAttachments`/`omitGitStatusAttachments` on
  ToolUseContext gate `claude_md_delta`/`memory_delta`/`nested_memory`/
  `git_status_delta` in `pipeline.ts`. New attachment producers read globals and
  bypass the gate — honor the flags explicitly or Explore/Plan/WebResearcher get
  full CLAUDE.md + rules re-injected per Read.

## 5. Running cache perf experiments

- Prototype as a `CLAUDIN_*` env toggle → A/B with
  `scripts/profile/cache-ab-bench.ts` → promote to default only on a measured win.
- **The bench is unreliable for head-to-head numbers**: `extractTimeline` rows are
  cumulative not delta, run-to-run variance is ~5×, and the `claude` binary exits
  1 under the harness. Cite the r:w direction/magnitude on the SAME harness run,
  never cross-tool absolute cost. Long-session-with-pauses is not exercised by the
  lockstep bench — revisit with a long-session bench before claiming parity.
