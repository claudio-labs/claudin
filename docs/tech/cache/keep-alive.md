# Prompt-cache keep-alive — an experiment, off by default

Status: **implemented behind `CLAUDIN_CACHE_KEEPALIVE=1`** (2026-09-10),
not promoted. `src/agent/cache/anthropic/keepAlive.ts` is the module,
`src/providers/shims/claude/streaming.ts` captures the body and arms it,
`src/providers/shims/claude/cacheControl.ts` reads the companion
`CLAUDIN_MAIN_CACHE_TTL=5m`. The probe that decides it is
`scripts/bench/ab/cache-keepalive-probe.ts`.

## The two bills it answers

From the 2026-09-09..10 census
(`.claudin/memory/team/token-census-2026-09-10-hidden-injections.md`):

1. **Sub-agents that wait.** A fresh sub-agent is cached at the 5m tier
   (`should1hCacheTTL`: `agent:*` → 5m, because "reads refresh the TTL for
   free within a run"). When it spawns nested Agents and waits 4–8 minutes
   for them, nothing reads its prefix, the TTL lapses, and the request that
   carries the results rewrites the whole thing — six times in two days,
   346k tokens, every one traceable to an `Agent` tool_use right before the
   drop. No TTL rule can prevent it: the write that expires is decided on
   request N, before the response that blocks exists.
2. **The main thread's 1h premium.** The main thread pays the 1h tier (2×
   the 5m write price) so a user pause does not rewrite the prefix. Over the
   two days that premium was $14.64; a ping every 4.5 minutes across the 23
   gaps of 5–60 minutes would have cost $3.33 at the 5m tier.

## Mechanism

Anthropic refreshes a cache entry's TTL every time it is **read**. So a
request that re-sends the last body with `max_tokens` at the floor is one
cache read (0.1× the input price) and buys another window for the entire
prefix.

- `noteRequestStarted(key)` on every real request cancels the pending ping
  for that agent (`key` = `agentId`, or `main`).
- `armKeepAlive(req)` in `streaming.ts`'s `finally` schedules the first ping
  4m30s after the response completes, only when the request was at the 5m
  tier and the caller did not abort.
- The ping re-sends the **same** params — `thinking` included, since changing
  it invalidates the message cache — with `stream: false` and
  `max_tokens: 1` (`CLAUDIN_CACHE_KEEPALIVE_MAX_TOKENS`), logs the usage it
  got back (`[cache keep-alive] <key>: read N created M ($x)` in the debug
  log), adds it to the session cost, and re-arms until
  `CLAUDIN_CACHE_KEEPALIVE_MAX_MIN` (default 30) after the first arm or
  until the next real request. A ping that errors stops the chain: a 400
  must never loop.

What it holds: one serialized request body per agent key for the life of the
chain. `streaming.ts` deliberately nulls its own copies after each request
so a 300k-token session's body can be collected; the keep-alive keeps the
last one on purpose, and only while the flag is on.

## What is not measured

**The subscription quota.** A ping is a request. Whether a Max/Pro plan
counts a request whose input is 99% cache reads at full weight, at read
weight, or per request is not documented, and the headless probe runs on the
same account as the live session, so it cannot separate the two. Until a
week of REPL use with the flag on shows the `/usage` meter moving at the
expected rate, this stays an experiment.

## Probe results

See the header of `scripts/bench/ab/cache-keepalive-probe.ts` — the three
arms (`1h`, `5m`, `5m+ka`) with a 6-minute pause before the third turn, and
the verdict line per arm.
