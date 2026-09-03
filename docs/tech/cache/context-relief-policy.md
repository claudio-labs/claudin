# Context relief — the mechanisms, what they cost, and the policy that replaced them

Status: **implemented** (`perf(cache): unify context relief into one
usage-driven policy`, 2026-09-03), on top of the measurements and
instrumentation from the same day
(`perf(cache): keep deferred tools in the prefix and surface server-side clears`).
Sections "Where the numbers come from" through "The cost model" describe the
four uncoordinated mechanisms as they were and why; "What shipped" at the end
is the current design. The mechanism numbers (1–5) are kept so the
instrumentation labels in old logs still resolve.

## What shipped

One decision, one source of truth, no message ever dropped from the API view:

- **`src/agent/compact/reliefPolicy.ts`** — pure. `decideRelief` has two
  lanes and one action:
  - *window*: `usedTokens > T`, `T = min(fraction × effectiveWindow,
    autocompactThreshold − margin)`, `margin = clamp(0.1 × window, 5k, 20k)`,
    fraction 0.75 retain / 0.5 aggressive (the existing
    `sizeStubThresholdFraction`). Target `T − B`, `B = reliefBandTokens`
    (60k, new profile field) clamped to 30% of `T`. 200k → T≈135k, target
    ≈94k; 1M → T≈735k, target 675k.
  - *rss*: retained full clearable tool_result tokens > `retainedHighWaterTokens`
    (250k retain) → target `retainedLowWaterTokens` (125k). This is the old
    byte-guard, expressed as the same action.
  - Both fired → one event sized by whichever asks for more.
  - `selectReliefIds`: oldest first until the request is covered.
- **`usedTokens` is real usage**: `tokenCountWithEstimation` (previous
  response's counted tokens + estimate of the tail), measured over
  `applyStableStubs(messages)` so the estimated part already reflects the
  clipped set. That is what makes the policy stateless: the clip is applied
  at the wire on the same request, the next response counts the stubs, and
  a request in between sees the stubbed estimate — no latch.
- **The action is the stable-stub clip** (`addClippedIds`), so the rewrite
  is byte-stable and keeps the head (`stubKeepHeadChars`): the cache breaks
  once per event and the model can still see the result existed.
- **One call site**: `microcompactMessages` (`microCompact.ts`), pre-request,
  REPL and headless alike. Gated on a `querySource` so `/context`, `/compact`
  and `analyzeContext` never mutate the clipped set (the old estimate trigger
  did). The time clip (mechanism 2) runs first, unchanged.
- **Candidate walk** `collectClearableCandidates` (`stableStubState.ts`):
  the old byte-guard's pass 1 — protected `keepRecentTurns`=2, pins, errors,
  images, `MIN_STUB_TOKENS`, head-stub savings — plus two new skips: ids
  already in the clipped set, and tools outside `isCompactableTool`.
- **Deleted**: the estimate-driven size trigger, `pruneToolResultsByBytes`
  (its pass 2), `evictOldStubbedMessages`, `evictToMaxSize`,
  `EVICT_MIN_BATCH`, `EVICT_TRIGGER_AT`, the REPL post-turn `reasons[]`
  block, the idle-gap sweep in `useOnSubmit`, and the per-iteration
  byte-guard in `QueryEngine` (now `applyStableStubs`, which frees the
  strings the pre-request clip marked). The REPL post-turn pipeline is
  `pruneOldToolResults` (aggressive only) → `applyStableStubs`.
- **Display cap is a render window**: `REPL.tsx` mounts the last
  `MAX_DISPLAY_MESSAGES` (200) of the state array; the array itself is never
  cut. Index-based consumers keep the full array.
- **Killswitch** `CLAUDIN_DISABLE_RELIEF_POLICY=1` turns off the window lane
  only; rss lane, time clip and autocompact remain. No legacy path is kept —
  the flag leaves a safe state, not the pre-policy one.
- **Instrumentation**: `[RELIEF] relief clip (N tool results, ~Xk tokens,
  window|rss lane): trigger T → target …` in `--debug`, the same string as
  the `notifyCacheDeletion` reason (`[PROMPT CACHE] expected drop: …`) and
  on the `[Cache: … • prefix rewritten: …]` line (main thread only).

Tests: `reliefPolicy.test.ts` (the decision table), `microCompact.test.ts`
(the shell: oldest-first band, no re-clip on the next request, analysis
callers, killswitch), `stableStubState.test.ts` (the candidate walk and the
rss lane end to end, pins), `requestDeterminism.invariant.test.ts`
(byte-stability of the new post-turn pipeline).

Adoption bench: `scripts/bench/ab/context-relief-ab.ts` — see the section at
the end.

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

## The four mechanisms as they were (plus one that is inert here)

Historical — 1, 3 and 4 no longer exist in this form (see "What shipped").
All of these removed or rewrote bytes **behind** the cache marker, so each
firing was one full rewrite of everything after the cut point. They are
listed in the order they ran.

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

## What the instrumentation records

- `[PROMPT CACHE] expected drop: <mechanism>` in `--debug` logs, naming
  which client mechanism announced the rewrite (`relief clip (N tool
  results, ~Xk tokens, window|rss lane)`, `idle-gap clip`; pre-policy logs
  also carry `display-cap eviction (112 msgs)`, `byte-guard stub`,
  `stable-stub clip (N tool results)`) — via the `reason` argument of
  `notifyCacheDeletion`.
- `[PROMPT CACHE BREAK] server clear_tool_uses (cleared N tool uses, -Xk
  tokens, expected)` when the response's `context_management.applied_edits`
  says the server edited the prompt; the summary is also stored on the
  turn's last assistant message (`applyMessageDeltaToLastMessage`).
- `[PROMPT CACHE BREAK] tools changed (+2/-0 tools: +EnterPlanMode,+ExitPlanMode)`
  — deferred tools now contribute their name to the detector's tool hash,
  so a discovery-driven array change is attributed instead of reading as
  "server-side (prompt unchanged)".
- The per-turn `[Cache: … read • hit N% • server cleared N tool results (-Xk)
  • prefix rewritten: relief clip (…)]` line and
  `/cache-stats` (`Server clears:` tally) — `cacheStatsTracker.ts`.

## The sketch the implementation followed

One decision, one source of truth. Written before the implementation; kept
for the reasoning, with what changed on the way marked inline.

1. **Source of truth = the previous response's real `usage`** (`input +
   cache_read + cache_creation`), never the client estimate. Estimates drift
   30%+ on code and are what made retain's 0.85 fraction fire too late in
   the bench. *Shipped as `tokenCountWithEstimation` over the stubbed view.*
2. **One trigger, relative to the effective window**, capped below the
   autocompact threshold — e.g. `min(0.7 × effectiveWindow, autocompact − 20k)`
   — replacing the fixed 140k, the 0.75 estimate, the 250k estimate and the
   300-message count. On a 1M model that is ~690k; on 200k, ~135k. *Shipped
   with the profile's existing 0.75/0.5 fraction and a margin that scales
   with the window (a fixed 20k swallowed small bench windows); the server's
   140k and the 250k rss high water stay as their own lanes because they
   bound different things (a different backend; process memory).*
3. **One relief action, in this order of preference**, applied once per
   event: (a) server `clear_tool_uses` when the beta is on (exact, cheap,
   keeps the array), else (b) stable-stub clip of the oldest clearable
   results down to a target band `B*` below the trigger (the clip is
   byte-stable, so the rewrite happens once), never (c) raw message eviction
   — the display cap should bound *rendering*, not the API view; the two
   arrays must be decoupled first (`messagesForSubmit` vs what Ink mounts).
   *Shipped: (a) is unchanged and fires first when its beta is on; (b) is
   the only client action; (c) is deleted and the display cap is a render
   slice.*
4. **Replace, don't drop**: whatever is cleared leaves a one-line stub with
   the head (`stubKeepHeadChars`) so the model knows the result existed and
   can re-read on demand instead of re-discovering. *Shipped: the only
   action is the head-preserving stable stub.*
5. **The session-start `cache_read=0` on call 2** (MCP pool settling) is a
   separate fix: hold the first request until `hasPendingMcpServers` clears,
   or send the deferred pool up front (which this PR already does for
   built-ins). *Not in this round.*

## Adoption bench

`scripts/bench/ab/context-relief-ab.ts`: two claudin binaries (this branch
vs the v1.1.24 build, `19b5c673`), Sonnet 5 pinned on both, 3 reps with
alternating arm order, a throwaway /tmp copy of `src/agent/compact/` +
`src/agent/cache/`, 30 scripted turns in three phases — 10 Greps, 10 full
Reads of the largest files, 10 Edits in those same files — graded by the
marker comments that landed. `--window=140000` on both arms (native 1M
never reaches a trigger in 30 turns), `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true`
on both so the server clear does not confound.

Run 2026-09-03, median of 3 (ranges in brackets):

| | v1.1.24 | this branch |
|---|---|---|
| cache write | 133k [115–136k] | 118k [114–164k] |
| uncached input | 185k [155–189k] | **81k** [72–94k] |
| prefix breaks / tokens rewritten | 2 / 45k | 2 / 30k |
| peak context | 105k | **87k** |
| lookups inside edit turns (Grep+Read) | 16 [9–16] | 16 [15–17] |
| edits landed | 30/30 | 29/30 |
| cost (CLI) | $2.00 [1.89–2.19] | **$1.49** [1.41–1.85] |
| wall | 249s | 172s |

Reading: the old build's estimate-driven trigger fired ~20k tokens late
(peak 105k against a 90k trigger — the 30% estimate drift the doc predicted),
so it carried a bigger prompt for the whole read phase; that is the whole
uncached-input and cost gap, and the ranges are separated. The prefix-break
count is equal by construction (both clip once past the trigger); the
branch rewrites fewer tokens per event. **Information loss is the same**:
in the edit phase both arms had already clipped the reads and both relocate
every anchor — v1.1.24 with `Grep`, the branch with `Read(outline)` — so
the Read-only `re-reads` column (8 vs 15) is a tool-choice artifact and the
all-tools `edit-turn lookups` column is the one to cite. The 29/30 is one
marker placed above a doc comment instead of directly above the export;
not relief-related. `scripts/bench/ab/context-relief-ab.json` has the raw
per-arm rows.
