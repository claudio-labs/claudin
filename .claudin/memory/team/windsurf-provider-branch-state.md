---
name: feat/windsurf-provider branch — state after 6 audit passes
description: Windsurf provider port branch as of 2026-06-05 — 14 commits, all P0/P1 audit-found bugs fixed, 108/108 windsurf + 494/494 test:provider green; a handful of confessed minor inconsistencies remain
type: project
---

Branch `feat/windsurf-provider` is at 14 commits as of 2026-06-05, after six review/audit passes (re-review v3, audit passes 4–6). All P0/P1 correctness bugs from the earlier passes were fixed: `scrubSystemSentinel` applied on array-text path; `eventTranslator` try/finally emits `content_block_stop` on mid-stream throw; `ModelNotAvailableError` translates to `APIError(403)` via an exported `mapCloudErrors` generator (no longer an inline closure); JWT piggyback honors epoch guard; OAuth `flushWaiters` error branch gained a state check (confirmed defensive — unreachable today since each `prepareLogin` opens its own loopback with 1 waiter). Tests: 108/108 windsurf + 494/494 test:provider, tsc clean.

**Why:** Audit pass 5 empirically reverted each "fix" and reran tests, caught two tautological tests (one was `expect(true).toBe(true)`, one re-called `APIError.generate` itself) that pass 4 had let through. Pass 6 then broke each production line of `mapCloudErrors` and confirmed 7 of 8 new tests guard real regressions.

**How to apply:** Known remaining issues, all confessed in commit messages — do NOT re-flag them as bugs unless you have new info:
- `nonStreaming.ts:142` mints its own `Message.id`, so non-streaming `data.id !== request_id`. Confirmed silent: no consumer compares; telemetry uses `request_id` only. Commit `a15b5dc`'s claim "ONE id threaded through both withResponse closures" was partial overclaim.
- `mapCloudErrors` tests for `unauthenticated` / `CloudAuthError` don't actually observe the JWT-clear side-effect (no public cache reader); only the status mapping is locked down. Test names overclaim but were left.
- `composeAbortSignal` fallback path is dead code under Node ≥22.12 (`AbortSignal.any` is native). Left as belt-and-braces.
- `JSON.stringify(block.input ?? {})` in `messageBuilder.ts:138` has no try/catch — circular refs would throw synchronously. Low risk (Anthropic-supplied input).
- `thinking: {type:'disabled'}` config is silently dropped — reasoning frames still surface.
- `nonStreaming` does NOT merge sequential text blocks when reasoning interleaves.
- Deferred: P1 #16 clock-skew JWT anchoring, P2 sessionCache (`session_id`/`cascade_id` not threaded → server cache miss every turn).
