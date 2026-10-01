---
name: turn-opening-full-prefix-rewrites
description: OPEN 2026-09-29 — the first request after a long main-thread turn often rewrites the whole cached prefix (server "messages changed", client "prompt unchanged", the prompt shrinks); ~$100 over 09-14..28, cause unknown; CLAUDIN_CACHE_BREAK_DUMP=1 captures the pair
type: project
paths:
  - src/providers/cache/promptCacheBreakDetection.ts
---

**Symptom:** on the first request of a new human turn the server re-bills the whole prefix as
a cache write (`messages changed (N missed)`) while the client's break detector reports
`prompt unchanged`. Measured in planning on 2026-09-28 over 09-14..28: 48 cases, ~$100 of
rewrite premium (22 of them one 09-23 bench). Rate 32.6% after a turn of ≥100 calls, 3.0%
after turns under 30, 11.6% with context over 300k. The prompt SHRINKS: Δctx < −2k in 69% of
these drops and in 0% of turn openings that kept the cache — something leaves the prompt
between a long turn's last request and the next turn's first, and the hash of the rendered
messages does not see it.

**Where:** the detector compares the client's rendered messages (`recordRenderedMessages` in
`streaming.ts` → `promptCacheBreakDetection.ts`), so it cannot explain a server-side miss.

**Hypotheses, none tested:** H1 the server drops or recounts the previous turn's thinking once a
new human turn arrives (client bytes identical); H2 a mutation after `recordRenderedMessages`,
or the detector's baseline overwritten; H3 the `cache_control` TTL or scope moving across
messages (stripped before hashing).

**Repro / capture:** claudindev with `CLAUDIN_CACHE_BREAK_DUMP=1` (off by default; each detected
break writes the previous and current wire bodies to `/tmp/claude-<uid>/cache-break-dumps/`),
a turn of ≥100 calls, then a short prompt within 5 minutes. Byte-diff the pair with
`cache_control` stripped, count_tokens both, and replay through `scripts/bench/ab/wire-proxy.ts`
varying the `clear_thinking` edit, the previous turn's thinking and the marker TTLs.

**Sibling (F4):** the system prompt grows +656..704 chars after EnterWorktree or entering plan
mode (4 sessions) and rewrites everything. The worktree half is probably the env section's
worktree note plus `WORKTREE_STASH_WARNING` (~600 chars, `computeSimpleEnvInfo`) and the longer
cwd — not verified; the plan-mode half is unexplained.

**Status:** open, 2026-09-29. The recorder is on main but no capture has been taken (no dump
dir existed on the dev machine). The same work (branch `perf/cache-levers-2026-09-28`) fixed the
detector's fan-out blindness (10 keys evicted by insertion order → 32, LRU) and the relief clip's
wrong key, so sub-agent floor drops now come out labeled.

**Why not fixed:** cause unknown; the plan budgets 1–2 days of captures before any change.
Plan `.claudin/plans/cozy-scribbling-thompson.md` (F3/F4); [[token-census-2026-09-28]].
