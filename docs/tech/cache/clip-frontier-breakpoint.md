# Clip-Frontier Cache Breakpoint

**Status:** Default ON (Phase 6 shipped). `CLAUDIN_CLIP_FRONTIER=0` reverts
the marker placement; `CLAUDIN_CACHE_PROFILE=aggressive` forces the old
clipping policy (unset resolves `auto` by provider).
**Scope:** `src/agent/compact/stableStubState.ts`, `src/providers/shims/claude/paramBuilders.ts`, `src/providers/shims/claude/streaming.ts`

## Problem

The Anthropic prompt cache is prefix-based and byte-exact: a single changed
byte at position X invalidates `[X..end]` of the cached prefix. Claudin's
stable-stub system keeps RSS bounded by rewriting old `tool_result` blocks to
deterministic stubs (`[clipped: ~N tokens from <tool>]`):

- `pruneOldToolResults(keepTurns=1)` fires on every appended `user` message
  (`QueryEngine.ts` — in a tool loop every tool_result IS a user message, so
  it fires per tool iteration, not per turn). It stubs non-error, non-image
  results ≥ `MIN_STUB_TOKENS` (100) behind the cutoff.
- `applyStableStubs` rewrites any id in the monotonic `clippedIds` set.

Meanwhile `addCacheBreakpoints` places the single message-level
`cache_control` marker by *distance from the end* (defer-walk,
`DEFAULT_DEFER_CACHE_MARKER_TOKENS = 2048`). The content being stubbed is old
(low index) — i.e. **before** the marker, inside the frozen prefix. Every
turn, the previous turn's full tool_result crosses the keepTurns cutoff and
mutates full→stub inside the cached prefix → the prefix from that point to
the marker is invalidated → a recurring cache write every turn. The
stable-stub header's "breaks ONCE per clip event" is technically true, but
with `keepTurns=1` there is a clip event per tool iteration.

Two more per-turn mutators behind the marker (both **on by default**,
`config.ts`): `stripOldThinkingBlocks(…, 2)` and
`stripOldNarrationBlocks(…, 2)` rewrite assistant messages once they age out
of their 2-turn keep windows — same sawtooth mechanism, different block type.

## Fix

Couple the marker position to the **clip frontier**: the largest index F such
that `messages[0..F]` are byte-stable across future turns. Mutation and
prefix-freezing become the same atomic event — bytes only ever change in the
uncached tail (which is re-billed every turn anyway), and what enters the
frozen prefix is the ~10-token stub, never the full content.

A block is **mutable** (frontier stops before it) when:

- `tool_result`, not yet a stub, non-empty, and:
  - its id is in `clippedIds` (pending explicit clip — covers the
    deferred-image case where `applyStableStubs` skips image content but
    keeps the id), or
  - it is non-error, non-image, ≥ `MIN_STUB_TOKENS` (the age prune will stub
    it once it crosses the cutoff).
- assistant message still carrying a `thinking` block, when
  `thinkingHistoryRedactionEnabled` (it will be stripped when it ages out of
  the keep window). `redacted_thinking` is never stripped → stable.
- assistant message mixing `text` + `tool_use` with no (redacted_)thinking,
  when `narrationHistoryRedactionEnabled` (mirrors
  `stripOldNarrationBlocks`' selection exactly).

Everything else — text, stubs, small results, errors, images outside
`clippedIds` — is stable and may be frozen.

**Do not** use `clippedIds` membership as a *stability* criterion:
`pruneOldToolResults` never registers ids in the set; age stubs are only
detectable via `CLIP_STUB_PATTERN` on the content.

## Implementation

1. `getClipFrontierIndex(messages, {thinkingIsMutable, narrationIsMutable})`
   in `stableStubState.ts` — pure, returns F, `-1` when even `messages[0]`
   is mutable.
2. `streaming.ts` computes the frontier on the **exact array** handed to
   `addCacheBreakpoints` (post `ensureToolResultPairing`, post
   `applyStableStubs`, post history redactions, post the retry-path
   re-strip), passing the config flags. Skipped for `skipCacheWrite` forks.
3. `addCacheBreakpoints` takes the frontier as an optional cap:
   `markerIndex = min(deferWalkResult, frontier)`. The defer-walk and
   head-pin survive — the marker still lingers until enough trailing tokens
   accumulate to register a usable server-side entry (~1024-token floor),
   it just never advances **past** the frontier. `-1`/`undefined` → no cap.

Shim paths (OpenAI/Codex) need no marker: their providers match by longest
unchanged prefix, so the byte-stability invariant (already enforced by the
stub idempotency, pinned by regression tests) is the whole win there.

## Why min(defer, frontier) instead of pure frontier

The defer-walk exists because the server has a minimum registrable delta
between consecutive checkpoints. Advancing the marker by a ~10-token stub
each turn would produce writes that don't register; harmless (the previous
checkpoint still hits, the tiny delta re-bills), but the lingering behavior
is strictly cheaper and already benchmarked. The cap only takes effect in
the harmful case: when the defer-walk would place the marker on or after a
block that is about to mutate.

## Invariants (pinned by tests)

- `stableStubState.test.ts` — frontier classification per block type;
  prune/stub idempotency; multi-turn simulation asserting the serialized
  prefix `[0..frontier]` from turn N is byte-identical at turn N+1 and the
  frontier never regresses.
- `addCacheBreakpoints.test.ts` — cap semantics (min with defer, head-pin
  preserved, `-1`/`undefined` no-ops, `skipCacheWrite` unaffected).

## Measured (2026-06-09, claude-sonnet-4-6, real API)

`bun run scripts/bench/ab/cache-ab-bench.ts --skip-claude --sequential`
(9 requests, 1 Read/turn over the repo's mixed-size files; 2 runs per side):

| | cache_write total | r:w | cost/run | per-turn cW profile |
|---|---|---|---|---|
| baseline (flag off) | 79.8k / 40.7k | 2.89:1 / 6.65:1 | $1.01 / $0.65 | sawtooth — 10–18k re-writes on late turns; cR stuck at the system+tools checkpoint (~27–30k) |
| `CLAUDIN_CLIP_FRONTIER=1` | 7.7k / 8.0k | 34.1:1 / 32.6:1 | $0.50 / $0.50 | flat ~0.5–2k; hot zone re-billed as plain input (1.0×) instead of written+broken |

Write −90%, cost −23..−51%, and — as predicted — the frontier side is
*stable across runs* while the baseline's write/cost depend on which turns
happened to break.

Free-pace mode (no per-turn pacing — each CLI batches Reads its own way;
same 30-file task, 1 run each, vs Claude Code on the same model):

| side | api reqs | cR | cW | r:w | cost | wall |
|---|---|---|---|---|---|---|
| claude (Claude Code) | 7 | 428.8k | 200.0k | 2.14:1 | $1.105 | 141.5s |
| claudin baseline | 4 | 128.4k | 56.2k | 2.28:1 | $0.982 | 53.3s |
| claudin frontier | 4 | 95.7k | 14.9k | 6.43:1 | $0.918 | 47.8s |

Reading this honestly: system prompts and pacing differ (claude ~17k system,
7 requests; claudin ~27k, 4 requests), so the cross-CLI numbers are
end-to-end task cost, not a controlled cache experiment. Notables: Claude
Code wrote 200k cache tokens for a task too short to amortize them (and hit
its own mid-run break — cR collapsed 144.9k→17.1k then re-wrote 51k);
claudin baseline shows the same break signature (T3: cR 27.5k→13.0k, then a
47.4k re-write); the frontier side shows neither. This is the design doc's
"don't chase the ratio" point in data: claude's big-prefix strategy yields
neither a higher r:w nor a lower bill here.

### Revisit workload (38 sequential reads: 30 files + 8 re-reads, strict 1 Read/turn)

`--sequential --revisits=8` — the fidelity case for real sessions: files get
revisited, and clip-based strategies pay the re-read while keep-everything
strategies serve it from cached prefix. All three sides honored ~1 read per
request this time (strict prompt):

| side | api reqs | cR | cW | r:w | cost |
|---|---|---|---|---|---|
| claude (Claude Code) | 39 | 3.59m | 242.5k | 14.8:1 | $2.19 |
| claudin baseline | 51 | 1.47m | 1.16m | 1.27:1 | **$12.67** |
| claudin frontier | 40 | 1.19m | 82.6k | 14.5:1 | $4.51 (rerun $5.84) |

Takeaways:

- The baseline's per-turn break **scales with session size**: $0.65–1.01 at
  9 requests → $12.67 at 51. cR repeatedly collapses to the bare system
  checkpoint (13k) followed by 20–55k re-writes — every turn.
- The frontier holds the same r:w as Claude Code (14.5 vs 14.8) with 3× less
  write volume, and cuts the baseline's cost by ~60%.
- Claude Code still wins total cost here: it pays 1.25× once per file and
  0.1×/turn thereafter, while clip-frontier claudin re-bills hot files at
  1.0× and pays revisits in full. That gap is the design doc's Phase 5 knob
  (on Anthropic pricing, clip by RSS pressure rather than age / raise
  keepTurns) — not a flaw in the frontier invariant.
- **Frontier-pinning pathology found and fixed**: the model thought on
  requests 1/2/3/5 only; the count-based thinking redaction ("keep last 2
  thinking-BEARING turns") left exactly 2 old thinking turns un-stripped
  forever → permanently mutable → frontier pinned near the head from T6–T32.
  `stripOldThinkingBlocks`/`stripOldNarrationBlocks` are now position-based
  (keep the last N ASSISTANT turns' thinking/narration), so stale
  thinking/narration ages out deterministically. Regression test:
  `messages.test.ts` "sporadic thinking".
- ~~Open for Phase 4~~ — both mysteries resolved by live monitoring
  (2026-06-10): the "residual deep break to a 13k checkpoint" is
  **autocompact firing mid-run** (the 13,281-token row is the compact
  summarization request itself, which reads only the global system block;
  Claude Code shows the identical signature when it complies with
  1-read-per-turn). And the "reported cost ~1.5× above list price" was a
  **headless model-selection bug**: `-p` mode ignored --model /
  ANTHROPIC_MODEL / project model entirely and served the subscription
  default (Opus 4.8[1m] at ~1.67× Sonnet pricing) while the init event
  reported the configured model — /cost was pricing the actually-served
  model correctly. Fixed in query.ts by adding the
  getUserSpecifiedModelSetting() leg to the appState fallback chain.
  Consequence: every claudin bench number above ran on Opus 4.8[1m]
  against claude on Sonnet — token comparisons hold, dollar columns
  overstate claudin by the Opus/Sonnet price ratio.

### Phase 5 — cache profile per provider (`CLAUDIN_CACHE_PROFILE`)

`services/compact/cacheProfile.ts`. Two profiles selected by transport (env
`CLAUDIN_CACHE_PROFILE=aggressive|retain|auto`; unset → aggressive until
Phase 6):

- **aggressive** (default, low-spread providers): today's behavior —
  `keepTurns=1`, display stub at 2k, microcompact size trigger at 50%.
- **retain** (anthropic/bedrock/vertex/deepseek under `auto`): age clipping
  off (`keepTurns=∞`, display stub off — the display array seeds the next
  turn's API view), microcompact size trigger at 85% (just under
  autoCompact's 92%), RSS bounded by `pruneToolResultsByBytes` (stub
  oldest-first past ~250k est. tokens of retained full results). The
  frontier treats full tool_results as stable under retain
  (`agePruneActive: false`) — only the rare clip event breaks, once.

Two pre-existing mechanisms were silently defeating retention and are now
profile-gated: `stubToolResultForDisplay` (2k immediate stub — meant to be
display-only but the display array seeds `messagesIncludingNewMessages`, so
cross-turn the model lost sight of every >2k result) and microcompact's
`SIZE_BASED_THRESHOLD=0.5` (clipped the retained prefix at half the window —
visible in the bench as the deep checkpoint collapsing back to system+stubs
at ~100k context).

Revisit-workload result (38 reads, sonnet-4-6, frontier+retain):

| side | cR | cW | r:w | cost |
|---|---|---|---|---|
| claude (Claude Code) | 3.59m | 242.5k | 14.8:1 | $2.19 |
| claudin frontier only | 1.19m | 82.6k | 14.5:1 | $4.51–5.84 |
| claudin frontier+retain | 2.79m | 79.8k | **35.0:1** | **$2.81** |

cR now plateaus upward exactly like Claude Code (28k→113k, re-grows after
each ~85% clip event), the model sees full content again (real summaries
instead of 1-token outputs), and cost lands within ~28% of Claude Code —
remaining gap: cold first write, the deliberate ~85% clip events, and the
residual deep break to a ~13.3k checkpoint (also seen on the frontier-only
runs; Phase 4 open item).

### Head-preserving stubs + cold-cache clipping (openclaude comparison follow-ups)

From the openclaude cache-architecture comparison, two provider-agnostic
optimizations (the Anthropic-server one — `cache_edits`/`cache_reference` —
is internal-only; its public analog `context_management` stays env-gated in
`services/cache/anthropic/apiMicrocompact.ts`):

1. **Head-preserving stubs** (`stubKeepHeadChars`: aggressive 1000 / retain
   2000 / `CLAUDIN_STUB_HEAD_CHARS` override). Stubbing now keeps the first
   N chars of the output above the marker —
   `<head>\n[clipped: ~N tokens from <tool> — head preserved]` — a SINGLE
   mutation with the same break cost as the pure stub, but the model retains
   file headers / top grep hits, cutting re-reads (the revisit bench's cost
   driver) and fixing the quality failure where the model summarized files
   it could no longer see. Applies to the age prune, the RSS byte-guard and
   the display stub; pure stubs still used when truncation wouldn't save
   ≥500 chars. Both stub forms are byte-stable and frontier-stable.
2. **Cold-cache clipping enabled under retain.** Claudin's time-based
   microcompact ("the cache is cold by definition when this fires") was dead
   in practice — gated behind a GrowthBook flag that the no-telemetry stub
   always returns disabled. `getTimeBasedMCConfig` now takes its defaults
   from the cache profile: retain enables it (gap 60min ≥ the 1h TTL, so the
   rewrite was happening anyway and the clip is free); aggressive keeps it
   off (everything old is already a stub).

### First equal-model run (2026-06-10, both sides actually on sonnet-4-6)

After the headless model fix, the first genuine equal-model A/B of the
revisit workload (parallel runs, both compliant at 1 read/turn):

| side | reqs | cR | cW | r:w | cost |
|---|---|---|---|---|---|
| claude (Claude Code) | 41 | 3.45m | 324.9k | 10.6:1 | $2.86 |
| **claudin frontier+retain (all fixes)** | 39 | 2.15m | 193.4k | **11.1:1** | **$1.94** |

**Claudin under Claude Code by 32%**, with a higher r:w, 40% less write
volume, zero compactions (38/38 reads + BENCH_DONE verified), and one
residual ~$0.46 reset from the TTL bucket flip below — without it the run
lands near $1.50.
Note the comparison caveat: claudin reads large files as structural
outlines (own Read-cap feature) while Claude Code reads full bodies, so
this is an end-to-end product comparison, not a pure cache-policy A/B.

**TTL bucket flip — root-caused and fixed.** The 5m entries came from
server-side `clear_thinking` (sent by default whenever thinking is on,
first-party): it is history redaction running on the SERVER with the same
keep-2 window pathology we removed client-side — each new thinking turn
rotates the window, mutates the effective prompt deep in the prefix, and
forces a full re-cache (the req-32 61k re-write fired the moment the model
thought again at the revisit phase). Now gated by the same
`historyRedactionEnabled` profile knob (off under retain; the >1h-idle
clearAllThinking variant stays — that clear is free). Two more follow-ups
shipped with it: server-side `clear_tool_uses` enabled under retain
(trigger 140k REAL tokens / keep 60k — the reliable near-ceiling backstop
below estimate-driven client microcompact and autocompact), and the
stream-json assistant events now carry real per-request usage (hold-1
buffer in runHeadless refreshes usage from the engine-side message before
serializing; last same-id event wins, matching Claude Code).

Original lead notes (kept for the record): The run's single deep reset
(req 32: cR collapsed to the 9.6k global block, 61k re-write) correlates
exactly with the `cache_creation` TTL buckets flipping: req 1 wrote 1h,
reqs 10–31 wrote 5m, req 32+ wrote 1h again. Mixing TTLs mid-session
diverges the server cache chain. Claudin's own annotations are constant
(`should1hCacheTTL` always true on first-party; both messageConverters
use it), so the 5m entries come from elsewhere — suspects: server-side
`context_management`/clear_thinking edits creating default-TTL entries,
or requests whose marker landed on a thinking-final assistant message
(assistantMessageToMessageParam skips the cache_control entirely in that
case → no message breakpoint that turn). Needs request-dump
instrumentation to settle.

### 50-file run (58 reads, post clear_thinking fix, both verified on sonnet)

claudin: **$2.22**, 59 compliant requests, r:w **22:1**, cW 159.3k, zero
compactions, 58/58 reads + BENCH_DONE. claude batched to 16 requests
($1.27) — pacing compliance is a coin flip, so per-turn comparison is
invalid; per-request, claudin ran at ~$0.038/req vs claude's ~$0.079/req.

Validated: the revisit-phase resets are GONE (clear_thinking gating works —
new thinking turns no longer rotate a server-side keep-window). Remaining:
exactly one reset at **~63k estimated context in both sonnet runs** (cR
collapses to the 9.6k global block, ~55k re-write ≈ $0.42, instant
recovery). The repeat at the same threshold across runs means a
deterministic mutator with a ~63k trigger is still unidentified —
enforceToolResultBudget reviewed and unlikely (decisions frozen at first
sight, per-message scope). Next step: CLAUDIN_DUMP_PREFIX_HASHES
instrumentation (block-level hashes per request) + a ~33-read repro run
(~$0.60) to diff the exact mutating block. Also still open: small per-turn
marker writes land in the 5m TTL bucket while system writes land in 1h
(mixed buckets within one request) despite getCacheControl always
annotating 1h on first-party — cosmetic-looking but unexplained.

### The ~63k deterministic reset — closed: server-side eviction (Phase 4 gate measured)

Instrumented repro (38 reads, `--debug-file` + `CLAUDIN_DUMP_CACHE_ANNOTATIONS`):

- promptCacheBreakDetection verdict at the reset (call #35, 65.4k→9.6k,
  57.4k re-write): **"likely server-side (prompt unchanged, <5min gap)"** —
  the client sent byte-identical prefixes. A smaller server-side partial
  drop (41.6k→39.2k) also appeared at call #14.
- Wire-annotation dump: every claudin cache_control is uniformly
  **ttl=1h** (system[1], system[2], message marker; tools carry no own
  marker and ride the following breakpoint). The recurring
  `ephemeral_5m_input_tokens` entries are NOT ours — they match the size
  of the live tail past the marker each turn, i.e. server-implicit
  entries.

Conclusion: the reset is Mycro-side eviction under this access pattern
(~5min session age / ~63k prefix), cost ~$0.42/event with instant
recovery — the exact "Fase 4: eviction" risk the original design doc
required measuring before trust. Client-side options if it ever matters:
the doc's own fallback (second near-tail marker) or reporting the pattern
upstream. Not a claudin bug; all client-side mutation sources found
during this work were fixed (age-prune frontier, thinking/narration
windows, server clear_thinking).

### Lockstep bench — the definitive equal-pacing comparison (2026-06-10)

`scripts/bench/ab/cache-lockstep-bench.ts` drives each CLI one user turn per
file via `--input-format stream-json` (next turn only after the previous
`result`), making batching impossible by construction — the prior
sequential-prompt runs depended on the model obeying a pacing instruction
that Claude Code ignored in 3 of 4 runs. 58 turns (50 files + 8 revisits),
both verified serving sonnet-4-6:

| side | turns | api reqs | cR | cW | r:w | resets | cost |
|---|---|---|---|---|---|---|---|
| claude (Claude Code) | 58 | 116 | 11.59m | 494.8k | 23.4:1 | 3 | $5.91 |
| **claudin (frontier+retain, post-review)** | 58 | 118 | 6.43m | 379.0k | 17.0:1 | 3 | **$4.49** |

Takeaways:

- **Claudin 24% cheaper at identical pacing and identical request counts.**
  The saving is structural: outline-reads keep the retained prefix ~45%
  smaller, so every one of the ~116 requests re-reads far fewer cached
  tokens (6.4m vs 11.6m) and each eviction re-write is cheaper.
- **Claude Code suffered the SAME 3 server-side evictions** (~every 5min of
  session age) — the ~5min reset is the server's behavior on this access
  pattern for ANY client, not a claudin defect. Its bigger prefix makes
  each eviction more expensive (494.8k total writes vs 379.0k).
- The ratio inverts the naive reading again: claude's r:w 23.4 vs claudin
  17.0, yet claudin's bill is lower — "don't chase the ratio" holds.
- Wall-clock: claudin ran ~2× faster per turn (smaller prompts).

### Sonnet 5 lockstep + trailing-marker experiment (2026-07-05)

Same lockstep harness, 30 turns (22 files + 8 revisits), `claude-sonnet-5`,
1 run per side. Third row is the `CLAUDIN_TRAIL_CACHE_MARKER=1` experiment:
a second breakpoint on the last message, converting the defer/frontier tail
window (~1–2k tokens re-sent as 1× input every turn) into cache write+read.

| side | api reqs | in | out | cR | cW | r:w | resets | cost |
|---|---|---|---|---|---|---|---|---|
| claude (Claude Code) | 61 | 122 | 992 | 13.09m | 305.6k | 42.8:1 | 0 | $5.87 |
| **claudin (frontier+retain)** | 63 | 72.7k | 7.0k | 5.34m | 195.3k | 27.3:1 | 0 | **$3.10** |
| claudin + trail marker | 69 | 138 | 7.7k | 7.30m | 291.3k | 25.1:1 | 1 | $4.06 |

Takeaways:

- **Claudin 47% cheaper than Claude Code on Sonnet 5** (was 24% on the
  06-10 sonnet-4-6 run) — the structural saving grows with context: 5.34m
  vs 13.09m cache reads, 0 resets on both sides.
- **Trailing marker: mechanism worked, economics didn't.** Uncached input
  fell 72.7k → 138 exactly as designed, but total cost rose $3.10 → $4.06.
  Root cause: on 1h-TTL providers (`should1hCacheTTL`) cache writes bill at
  **2× base**, not the 5m-TTL 1.25× — so rewriting the mutating tail every
  turn (2×) loses to re-sending it as 1× input. Break-even needs the tail
  byte-stable for ~2+ turns; the defer window rarely is. Cost decomposition
  reconciles to the cent with $6/M cW: baseline $0.22 in + $1.17 cW vs
  trail $0.00 in + $1.75 cW (+6 requests / 1 reset of run variance in cR).
- **Corollary: the 72.7k "ugly" uncached input is the optimum**, not waste —
  1× re-send is the cheapest treatment for bytes that mutate next turn under
  Anthropic-style pricing. Flag stays off by default; may be worth re-testing
  on 5m-TTL (1.25× write) providers where the premium is 5× smaller.

### Provider cache research → retain coverage extended (2026-06-10)

Web research on the other transports' caching:

- **OpenAI (api.openai.com)** — automatic prefix caching (≥1024 tok), **no
  write surcharge**, cached input up to **90% off** on current models;
  default TTL 5–10 min (max 1h), `prompt_cache_retention: '24h'` available;
  `prompt_cache_key` improves routing (~8.5% hit-rate in OpenAI's own
  benchmarks); Responses API shows 40–80% better cache utilization than
  Chat Completions.
- **Codex / ChatGPT OAuth** — Responses API mechanics above, plus
  subscription billing: clipping saves no money at all.
- **GitHub Copilot** — token-based AI-Credits billing (since 2026-06-01)
  prices cached tokens at ~10% of input.

Consequences shipped: `resolveProfileForProvider` now returns **retain**
for `codex_responses`, `github_copilot` and `openai_compat` pinned to
api.openai.com (generic routers/Azure/local stay aggressive — caching
behavior unknown); and the OpenAI shim sends a session-stable
`prompt_cache_key` + `prompt_cache_retention: '24h'` on official-OpenAI
requests only (third-party backends may reject unknown params).

**Follow-up (2026-08-20):** this round had no xAI/Grok entry, and two of its
OpenAI facts have since moved (cache writes now bill 1.25× on GPT-5.6+;
`prompt_cache_retention` is superseded by `prompt_cache_options.ttl` on the
newest models). See
[`native-prompt-caching-by-provider.md`](native-prompt-caching-by-provider.md)
— it also finds that Grok, on `openai_compat`, sends no cache routing hint at
all because xAI's key travels as the `x-grok-conv-id` **header**.

Bench note: claudin's stream-json emits assistant events before
`message_delta` delivers final usage (the in-memory message is fixed up by
mutation), so per-request usage on stdout is all zeros; the bench falls back
to the session transcript, which is flushed after the mutation and carries
the real numbers.

## Rollout gates (remaining phases from the design discussion)

- ~~**Baseline bench**~~ — done, see Measured above.
  `promptCacheBreakDetection.ts` attribution check still pending in a live
  interactive session.
- **Server A/B**: a marker deep in the prefix is a different usage pattern
  from the near-tail marker the single-marker rationale in
  `paramBuilders.ts` optimized for (KV-local eviction). Measure before
  defaulting on; rollback = unset the flag.
- **Per-provider cache profile** (`keepTurns` / `MIN_STUB_TOKENS` by
  write/read multiplier) is follow-up work, not part of this change.
