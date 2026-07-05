# Prompt-Cache Policy (clip-frontier + per-provider profile)

Claudin treats the provider's prompt cache as a first-class cost surface. Two coupled mechanisms — the **clip-frontier breakpoint** and the **per-provider cache profile** — guarantee that history management (stubbing, redaction, eviction) never silently invalidates the cached prefix, and that how aggressively history is trimmed matches each provider's actual cache pricing.

**On by default. No configuration required.**

## The problem

Prompt caches are prefix-based and byte-exact: one changed byte at position X invalidates everything from X to the end of the cached prefix. Every coding-agent CLI mutates its own history — stubbing old tool results to bound memory, stripping aged-out thinking blocks, compacting. If any of those rewrites lands *behind* the cache marker, the provider re-bills the whole tail as a cache **write** (1.25× input price on Anthropic) instead of a cache **read** (0.1×).

This is not hypothetical — it is what the upstream design does, and what Claudin's own baseline did before this feature:

- The age-prune stubs the previous turn's tool_result every turn — always *before* the marker → a recurring per-turn cache break.
- Thinking/narration redaction rewrites assistant messages as they age out of their keep window → same sawtooth, different block type.
- The cost **scales with session length**: on a 38-read benchmark workload the per-turn break took the baseline from ~$1/run at 9 requests to **$12.67** at 51 requests, with cache reads repeatedly collapsing to the bare system checkpoint followed by 20–55k-token re-writes.

Other CLIs avoid the sawtooth by simply never trimming (keep everything, cache it all) — which buys a high hit ratio at the price of a huge prefix: every eviction re-write is enormous, and providers without cheap cached reads bill the whole retained history at full input price every turn.

## What Claudin does differently

### 1. The clip-frontier invariant

The cache marker is capped at the **clip frontier** — the largest index F such that `messages[0..F]` are byte-stable for the rest of the session. Anything that is *going to mutate later* (a full tool_result the age-prune will stub, an assistant message still carrying strippable thinking) is kept **outside** the frozen prefix until it has reached its final byte form.

Mutation and prefix-freezing become the same atomic event: bytes only ever change in the uncached tail (re-billed every turn anyway), and what enters the frozen prefix is the ~10-token stub, never the full content that would later flip. The recurring per-turn break is structurally impossible, not just unlikely.

### 2. Per-provider cache profile

`auto` (the default) resolves how eagerly to trim by what the provider's cache actually costs:

| Profile | Providers | Behavior |
|---|---|---|
| **retain** | Anthropic, Bedrock, Vertex, DeepSeek, official OpenAI, Codex/ChatGPT OAuth, GitHub Copilot | Keep tool_results full (cached reads are cheap — let them pay), age clipping off, RSS bounded by a byte-guard that stubs oldest-first, microcompact only near the window ceiling, server-side `clear_tool_uses` as the near-ceiling backstop |
| **aggressive** | Everything else (generic OpenAI-compatible routers, Azure, local models — caching behavior unknown) | Clip per turn; small prompts beat speculative retention when cached reads aren't discounted |

One policy knob, resolved per transport — instead of one hardcoded strategy that is wrong for half the providers Claudin supports.

### 3. Byte-stability everywhere (shims included)

Three rules back the invariant (pinned by the integrated regression suite `requestDeterminism.invariant.test.ts`):

- **Stub bytes are first-write-wins** — the first stub emitted for a tool_use_id records its exact bytes and every later rewriter replays them; two views of the same id can never flip the wire bytes.
- **History deletions are amortized and announced** — evictions fire in batches, never one-at-a-time churn.
- **The tool pool never churns bytes gratuitously** — MCP tool updates replace in place, schemas survive transient failures, deferred-tool announcements ride persisted attachments instead of mutating `messages[0]`.

Because OpenAI-style providers match by *longest unchanged prefix* with no explicit marker, byte-stability alone is the whole win there — the shim paths (OpenAI-compatible, Codex) inherit the benefit with zero provider-specific code. On official OpenAI, the shim additionally sends a session-stable `prompt_cache_key` and `prompt_cache_retention: '24h'`.

### 4. Head-preserving stubs

When a tool_result is stubbed, the first N chars survive (`aggressive` 1000 / `retain` 2000): `<head>\n[clipped: ~N tokens from <tool> — head preserved]`. Same single-mutation break cost as a pure stub, but the model keeps file headers and top grep hits — cutting the re-reads that dominate revisit-heavy sessions, and fixing the quality failure where the model "summarized" files it could no longer see.

## The gain

Measured on the lockstep bench (`scripts/profile/cache-lockstep-bench.ts` — one user turn per file via `--input-format stream-json`, so pacing is identical by construction; 58 turns, both sides verified serving claude-sonnet-4-6, 2026-06-10):

| side | api reqs | cache read | cache write | cost |
|---|---|---|---|---|
| Claude Code | 116 | 11.59m | 494.8k | $5.91 |
| **Claudin** | 118 | 6.43m | 379.0k | **$4.49** |

- **24% cheaper at identical pacing and identical request counts.** The saving is structural: Claudin's retained prefix stays ~45% smaller (outline-reads contribute here too — see `docs/features/7.1-smart-code-navigation.md`), so every request re-reads far fewer cached tokens and each server-side eviction re-write is cheaper.
- Both sides suffered the same 3 server-side evictions (~every 5 min of session age on this access pattern) — that reset is the server's behavior for *any* client; Claudin's smaller prefix just makes each one cost less.
- Wall-clock: ~2× faster per turn (smaller prompts).
- Versus its own pre-feature baseline, the clip-frontier alone cut cache writes **−90%** and per-run cost −23..−51% on the directional bench, and eliminated the $12.67 session-scaling blow-up entirely.
- Honest caveat: a higher read:write ratio is *not* the goal and Claudin doesn't chase it — on the lockstep run Claude Code had the better ratio (23.4:1 vs 17.0:1) and the higher bill. The metric that matters is dollars per task.

## Why this beats autocompact (graceful degradation vs the cliff)

Autocompact — the upstream pressure valve — fires at ~92% of the context window and summarizes the **entire conversation** into one message. It is a cliff: one catastrophic, irreversible, lossy event. The model loses the exact bytes of everything at once, and worse, **it doesn't know what it doesn't know** — a summary carries no manifest of what was omitted, so nothing lost can be deliberately recovered. It is also a full cache reset (the whole prefix is rewritten), plus the cost of the summarization request itself.

Claudin's layers degrade context **selectively, incrementally, and recoverably** instead. The key observation is that history holds two classes of content:

| Class | Recoverable? | What Claudin does |
|---|---|---|
| **Tool outputs** (Read, Grep, Bash results) | Yes — the file is still on disk, the command can be re-run | Degrade oldest-first to a head-preserving stub: `<head>\n[clipped: ~N tokens from Read — head preserved]`. The stub names the tool and the size of what was cut, so the model knows *exactly* what it lost and can re-fetch surgically if needed |
| **Conversation text** (user instructions, decisions, the model's own conclusions) | No — it exists only in the history | Never touched by any layer |

Autocompact destroys both classes indiscriminately — including the only one that cannot be re-fetched. Claudin's layers only ever spend the recoverable class.

The layers form a ladder, each deferring the next, with autocompact demoted to last resort:

1. **Outline reads** — large files enter context as a skeleton, not a body (less pressure in the first place)
2. **Age prune / RSS byte-guard** — oldest tool outputs degrade to head+stub
3. **Microcompact at 85%** (retain) — explicit tool_result clips; still no summary, conversation intact
4. **Server-side `clear_tool_uses` at 140k real tokens** — near-ceiling backstop
5. **Autocompact at 92%** — last resort only

Measured consequence: the benchmark runs (38- and 58-read workloads) finished with **zero compactions** on the Claudin side, while the baseline/Claude Code runs hit autocompact mid-run — visible in the cache traces as the ~13.3k checkpoint collapse, which is the summarization request itself reading only the system block. The cliff never fired because the ladder kept it out of reach.

## Structure

Policy is centralized; mechanisms live with their subsystems:

```
src/services/cache/
  README.md            map of the whole system (start here)
  cacheProfile.ts      provider → profile resolver (auto/aggressive/retain)
  anthropic/           Anthropic-server-only policy (context_management beta:
                       clear_tool_uses / clear_thinking)
```

Key mechanism pointers (full list in `src/services/cache/README.md`):

- `src/services/compact/stableStubState.ts` — stable stubs, first-write-wins byte registry, age prune, RSS byte-guard, **`getClipFrontierIndex`**
- `src/services/api/claude/paramBuilders.ts` — `addCacheBreakpoints`: defer-2048 walk capped at `min(defer, frontier)`
- `src/services/api/claude/streaming.ts` — wiring order: pairing → stable stubs → history redactions → frontier → breakpoints
- `src/services/compact/microCompact.ts` — explicit clips; size trigger profile-gated (0.5 aggressive / 0.85 retain)

## Smaller design wins riding the same invariants

- **Clipping is free when the cache is already cold.** Under `retain`, the time-based microcompact fires only after an idle gap ≥ the 1h cache TTL — the server entry has already expired, so the next request re-writes the prefix regardless; the clip costs nothing extra. Under `aggressive` it stays off (everything old is already a stub). Upstream, this path was dead code behind a remote flag.
- **Forks don't pollute the cache.** Fire-and-forget sub-agent forks (`skipCacheWrite`) shift their marker to the last *shared-prefix* message: the write is a no-op merge on the server (the parent's entry already exists) and the fork never registers its own tail. The flip side is the fork-subagent feature: a default `Agent(...)` spawn inherits the parent's full context **and its warm prompt cache**, so sub-agents start from cache hits instead of a cold prefix.
- **One marker, 1h TTL, on purpose.** Claudin places exactly one message-level marker (two markers pin server-side KV pages that nothing will ever resume from — see the comment in `paramBuilders.ts`) and annotates 1h TTL on first-party Anthropic, deferred until ≥2048 trailing tokens accumulate so every write registers a usable entry.

## Observability — how to tell it's working

- **Built-in break detection** (`src/services/api/promptCacheBreakDetection.ts`): every request's prompt state is hashed per-section (system, tools, per-message); when `cache_read` drops unexpectedly, the detector classifies the break — *client-side* (which section's bytes changed, with a diff written to disk) vs *likely server-side* ("prompt unchanged, <5min gap"). This is how the ~63k reset was root-caused to server eviction rather than a Claudin bug.
- **Wire dumps for deep debugging**: `CLAUDIN_DUMP_CACHE_ANNOTATIONS` logs every `cache_control` annotation actually sent (marker position, TTL); `CLAUDIN_DUMP_PREFIX_HASHES` dumps block-level hashes per request to diff the exact mutating block across turns.
- **In-session**: `/cost` prices cache reads/writes per the actually-served model.
- **Reproducing the numbers**: `scripts/profile/cache-lockstep-bench.ts` is the reliable harness (one user turn per file via `--input-format stream-json` — identical pacing by construction). `cache-ab-bench.ts` exists but is exploratory-only; don't cite its numbers.

## Limitations & honest notes

- **Server-side eviction is out of our hands.** On read-heavy access patterns the Anthropic server evicts the entry roughly every 5 minutes of session age (~$0.42/event, instant recovery). It hits *any* client — Claude Code suffered the identical 3 resets on the lockstep run — and Claudin's smaller prefix only makes each one cheaper, not avoidable.
- **`retain` trades memory for cost**: full tool_results stay in history until the RSS byte-guard (~250k estimated tokens of retained results) stubs oldest-first. Bounded, but a long retain session holds more than an aggressive one.
- **`aggressive` is a guess for unknown backends.** Generic OpenAI-compatible routers, Azure, and local models get `aggressive` because their caching behavior is unverified — if your backend does discount cached input, `CLAUDIN_CACHE_PROFILE=retain` may be the better setting.
- **On subscription billing (Codex/ChatGPT OAuth) clipping saves no money at all** — which is exactly why those transports resolve to `retain`: keep the context, there is nothing to save by trimming.
- **Cross-CLI cost numbers are end-to-end product comparisons**, not isolated cache A/Bs — outline-reads and prompt-size differences contribute alongside the cache policy. The doc cites only the lockstep harness, where pacing and request counts are equalized by construction.

## How to activate / deactivate

Everything is on by default. Overrides, per knob:

| Override | Effect |
|---|---|
| `CLAUDIN_CLIP_FRONTIER=0` | revert to uncapped (defer-walk-only) marker placement |
| `CLAUDIN_CACHE_PROFILE=aggressive\|retain` | force a profile instead of `auto` per-provider resolution |
| `CLAUDIN_STUB_HEAD_CHARS=<n\|0>` | head-preserved chars per stub (`0` = pure stubs) |
| `CLAUDIN_TRAIL_CACHE_MARKER=1` | (off by default — measured regression, see below) second breakpoint on the last message — converts the defer/frontier tail window from repeated 1× input into cache write + reads; suppresses `CLAUDIN_ANCHOR_CACHE_HEAD` to stay within the 4-breakpoint API budget. Lockstep bench 2026-07-05 (Sonnet 5, 30 turns, 1 run each): uncached input dropped 72.7k → 138 as designed, but total cost rose $3.10 → $4.06 — on 1h-TTL providers (firstParty/vertex) cache writes bill at 2× base, so rewriting the mutating tail every turn costs more than re-sending it as 1× input (cW +96k, plus 1 reset and +6 requests of run variance). Keep off on Anthropic-style pricing; may be worth re-testing on 5m-TTL (1.25×) providers |

## Detailed docs

- `src/services/cache/README.md` — system map, the three byte-stability rules, mechanism pointers
- `docs/tech/cache/clip-frontier-breakpoint.md` — full design rationale, every measured run (including the failed/corrected ones), root-caused server-side behaviors
