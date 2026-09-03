# Context relief — the mechanisms, what they cost, and the policy we don't have yet

Status: **design notes for a future round**, written 2026-09-03 alongside the
instrumentation that makes this measurable
(`perf(cache): keep deferred tools in the prefix and surface server-side clears`).
Nothing here is implemented as a unified policy. Read it before touching any
of the four knobs below, because they don't know about each other.

## Where the numbers come from

One week of real sessions in this repo (2026-08-27 → 09-03): 20 sessions,
1,965 API calls, `claude-opus-5` (1M window), Anthropic OAuth, `retain` profile.

| metric | value |
|---|---|
| input tokens served from cache | 370.8M (96.8%) |
| `cache_creation` (all at the 1h tier, 2× write price) | 5.99M (1.6%) |
| uncached input (the defer-marker tail) | 6.34M (1.7%) — p50 3.4k / p90 5.2k per call |
| read:write | 62:1 |
| prefix breaks (cache_read dropped >2k vs previous call) | 27 in 1,965 calls (1.4%) |
| tokens rewritten by those 27 breaks | 1.92M = **32% of all cache_creation** |

Cost-equivalent at Anthropic list prices: ~$937 actual, $5,854 without caching,
$681 theoretical floor (everything read, nothing written). So the whole
remaining headroom is ~27%, and the part that is *policy* — the 27 breaks — is
about a third of that.

Break causes, by what happened between the previous call and the break:

| cause | n | tokens rewritten |
|---|---|---|
| history dropped ≥50% at a new user prompt (419k→53k, …) | 8 | 465k |
| ToolSearch discovered a deferred tool (fixed in this PR) | 6 | 497k |
| new user prompt + history shrank 10–47k | 6 | 701k |
| task-notification + history shrank | 2 | 115k |
| session start, 2nd call `cache_read=0` (MCP pool settled) | 1 | 52k |
| mid-loop, same size (server-side noise) | 3 | 21k |

None of the 8 "≥50%" drops is a compaction — zero `isCompactSummary` rows in
those 8 transcripts. They and the 6+2 "shrank" drops are the client-side
mechanisms below firing; which one is what the instrumentation now records.

## The four mechanisms (plus one that is inert here)

All of these remove or rewrite bytes **behind** the cache marker, so each
firing is one full rewrite of everything after the cut point. They are
listed in the order they run.

### 1. Client size-driven stable-stub clip — `src/agent/compact/microCompact.ts`

Trigger: `estimateMessageTokens(messages) > min(0.75 × effectiveWindow,
autocompactThreshold − 5k)` (`sizeStubThresholdFraction`, retain). Freezes
all but the last 2 compactable tool_results into the clipped set; from then
on every request rewrites them to the same stub bytes (stable — one break,
then warm). On a 1M model the trigger sits at ~735k **estimated** tokens, so
it effectively never fires there; on a 200k model it is ~135k.

### 2. Time-based clip — same file, `maybeTimeBasedMicrocompact`

Trigger: idle gap > 60 min (retain `timeBasedGapMinutes`). Free by
construction: the 1h cache already expired, so clipping before the rewrite
only shrinks what gets rewritten. Persists through the same clipped set.

### 3. Byte-guard — `stableStubState.ts::pruneToolResultsByBytes` (REPL post-turn)

Trigger: retained full tool_result tokens > 250k **estimated** → stub the
oldest until ≤ 125k. Its purpose is RSS (≈1 MB of string payload per 250k
tokens); it is only reachable on 1M-window models or pathological
accumulation. When it fires it removes ~125k+ of content in one step — the
shape of the 8 biggest drops in the table above. Runs in
`useOnQuery.ts` after every turn, so the rewrite lands on the next turn's
first request.

### 4. Display-cap eviction — `stableStubState.ts::evictToMaxSize` (REPL post-turn)

Trigger: display array > `EVICT_TRIGGER_AT` (300) → cut to
`MAX_DISPLAY_MESSAGES` (200). Hysteresis band = ~100 messages, so it fires
roughly once per 100 display messages once a session is past 300. Under
retain the evicted messages carry FULL tool results (nothing was stubbed),
so each cut both rewrites the prefix and loses whatever the model had read
in those messages. This is the best match for the "shrank 10–47k at a new
prompt, every ~25 calls" pattern in session 6bbe7c74: 50–76 transcript
messages per cycle ≈ 100 display messages once attachments are counted.
`evictOldStubbedMessages` (batch of 24 stub-only pairs) is the same shape
for stubbed content.

### 5. Server-side `clear_tool_uses` — `src/agent/cache/anthropic/apiMicrocompact.ts`

Trigger: real input tokens > 140k → clear at least 80k of clearable tool
results (down to a 60k working set). Sent under retain when the
`context-management` beta header is on. **In this environment it never
fires**: `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true` is set in the user's
shell, `shouldIncludeFirstPartyOnlyBetas()` returns false, the header is not
sent, and `context_management` is dropped from the body
(`streaming.ts`, the `useBetas && betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER)`
guard). Verified 2026-09-03 with `API_MAX_INPUT_TOKENS=45000`: five Reads
took the prompt to 137k and every response carried `context_management: null`.
So the retain profile's documented "near-ceiling backstop" is inert here,
and the cycles observed in the week are entirely client-side (3 and 4).

When the header IS on, the clearable list is now derived from the tool pool
(`clearableResult: true` on the Tool, `clearableToolNamesFromPool`) instead
of a hand-kept constant that had silently excluded every fork tool (Git,
Build, RunTests, Typecheck, LSP, Monitor, Container).

## The cost model (why "raise the trigger" is not the fix)

Prices (Anthropic, per token): read `r = 0.1`, 1h write `w = 2.0`, relative
to base input. Let the context grow `g` tokens per call (≈1.5k/call measured
in tool loops), a relief event cut the history by a band `B` and leave `R`
tokens that get rewritten at `w`. Period between events `N = B / g`. Cost per
call:

```
f(B) = w·R·g / B  +  r·(R + B/2)
```

Minimizing: `B* = sqrt(2·w·R·g / r)`. With `R ≈ 60k`, `g ≈ 1.5k`:
`B* ≈ sqrt(2·2·60k·1.5k / 0.1) ≈ 60k`. The server clear's 80k band and the
display cap's ~35–45k effective band both sit within a few percent of the
optimum; `f` is flat around `B*` (a 40k band costs ~$0.19/call vs $0.18 at the
optimum). **Tuning the band buys almost nothing.** What the current design
loses is not dollars but *information*: mechanisms 3 and 4 drop full tool
results with no summary, so the model re-reads (more calls) — a cost the
token accounting does not attribute to the eviction.

## What the instrumentation now records

- `[PROMPT CACHE] expected drop: <mechanism>` in `--debug` logs, naming
  which client mechanism announced the rewrite (`display-cap eviction (112
  msgs)`, `byte-guard stub`, `stable-stub clip (N tool results)`, `idle-gap
  clip`, …) — via the `reason` argument of `notifyCacheDeletion`.
- `[PROMPT CACHE BREAK] server clear_tool_uses (cleared N tool uses, -Xk
  tokens, expected)` when the response's `context_management.applied_edits`
  says the server edited the prompt; the summary is also stored on the
  turn's last assistant message (`applyMessageDeltaToLastMessage`).
- `[PROMPT CACHE BREAK] tools changed (+2/-0 tools: +EnterPlanMode,+ExitPlanMode)`
  — deferred tools now contribute their name to the detector's tool hash,
  so a discovery-driven array change is attributed instead of reading as
  "server-side (prompt unchanged)".
- The per-turn `[Cache: … read • hit N% • server cleared N tool results (-Xk)
  • next turn rewrites prefix: display-cap eviction (112 msgs)]` line and
  `/cache-stats` (`Server clears:` tally) — `cacheStatsTracker.ts`.

Collect a week of sessions with these on before designing the policy below.

## Sketch of the unified policy (not implemented)

One decision, one source of truth, one hysteresis:

1. **Source of truth = the previous response's real `usage`** (`input +
   cache_read + cache_creation`), never the client estimate. Estimates drift
   30%+ on code and are what made retain's 0.85 fraction fire too late in
   the bench.
2. **One trigger, relative to the effective window**, capped below the
   autocompact threshold — e.g. `min(0.7 × effectiveWindow, autocompact − 20k)`
   — replacing the fixed 140k, the 0.75 estimate, the 250k estimate and the
   300-message count. On a 1M model that is ~690k; on 200k, ~135k.
3. **One relief action, in this order of preference**, applied once per
   event: (a) server `clear_tool_uses` when the beta is on (exact, cheap,
   keeps the array), else (b) stable-stub clip of the oldest clearable
   results down to a target band `B*` below the trigger (the clip is
   byte-stable, so the rewrite happens once), never (c) raw message eviction
   — the display cap should bound *rendering*, not the API view; the two
   arrays must be decoupled first (`messagesForSubmit` vs what Ink mounts).
4. **Replace, don't drop**: whatever is cleared leaves a one-line stub with
   the head (`stubKeepHeadChars`) so the model knows the result existed and
   can re-read on demand instead of re-discovering.
5. **The session-start `cache_read=0` on call 2** (MCP pool settling) is a
   separate fix: hold the first request until `hasPendingMcpServers` clears,
   or send the deferred pool up front (which this PR already does for
   built-ins).

Adoption gate: `scripts/bench/ab/cache-lockstep-bench.ts`, N≥3, on a
long-session workload that crosses the trigger at least twice; compare
`cache_creation`, re-read count (`Read` calls on already-read paths) and
r:w against the current four-knob behavior. Don't ship on cost alone — the
re-read count is where the current design leaks.
