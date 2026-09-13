# The lagging cache marker — keeping the last write inside the lookback window

Status: shipped 2026-09-13 (branch `fix/cache-lag-marker`). On by default;
`CLAUDIN_DISABLE_LAG_CACHE_MARKER=1` turns it off.

## The bug

Session `ab1e69e8` (2026-09-13, opus-5 on the 1M window, 879 API calls, context
up to 722k) paid **seven full rewrites of its message history**:

| time | rewrote | context | `input_tokens` before → on the call |
|---|---|---|---|
| 00:35:58 | 192k | 219k | 6194 → 2 |
| 00:53:25 | 266k | 295k | 3741 → 2059 |
| 01:31:32 | 435k | 463k | 4456 → 39 |
| 02:10:25 | 446k | 474k | 3483 → 2 |
| 02:18:47 | 481k | 511k | 4391 → 2016 |
| 03:34:28 | 685k | 715k | 2987 → 1813 |
| 03:36:07 | 558k | 591k | 5040 → 5332 |

3.06M of the session's 3.80M cache-write tokens (81%), at the 1h tier. On every
one, `cache_read` fell to exactly 27,532 — the tools+system breakpoint — and the
`[Cache:]` line said `likely server-side (prompt unchanged, <5min gap)`. The
detector was right about the bytes: it hashes system, tools, betas, effort,
extra body and every rendered message, and none had changed. No compaction ran.

Over the last 30 days of transcripts (`scripts/bench/tokens/lookback-miss-census.ts
--since=30`): 213 sessions, 414 such events, **35.9M of 92.9M cache-write tokens
(38.6%)**, 389 of them landing on the floor, only 15 behind an idle gap over an
hour.

## The mechanism

`addCacheBreakpoints` (`src/providers/shims/claude/paramBuilders.ts`) emits one
message-level `cache_control`, deferred to the earliest index whose suffix is
≥ 2048 estimated tokens. During a run of tiny tool calls (TaskUpdate, a short
Grep) the marker crawls while the uncached tail grows to 3–6k real tokens over
15–30 messages. The next big block — a pasted screenshot, a Read that drags a
rule file in, an apply_patch — makes the walk from the end reach the threshold
within one message, and the marker jumps to the tail in a single step.

Anthropic's prompt-caching documentation ("lookback window"):

> The lookback window is 20 blocks. The system checks at most 20 positions per
> breakpoint, counting the breakpoint itself as the first. If the system finds
> no matching entry in that window, checking stops (or resumes from the next
> explicit breakpoint, if any). On the Claude API, a run of consecutive
> `tool_use` blocks counts as one position, and so does a run of consecutive
> `tool_result` blocks […]
>
> If a growing conversation pushes your breakpoint 20 or more blocks past the
> last cache write, the lookback window misses it. Add a second breakpoint
> closer to that position from the start so a write accumulates there before
> you need it.

That is the whole story: the jump exceeds 20 positions, the lookup from the new
marker finds nothing, resumes at the system breakpoint, and everything between
is written again. The transcript signature is `input_tokens` collapsing on the
same call `cache_read` collapses (5 of the 7 above; the 03:36 one, with entries
six positions back and the same bytes re-counted 131k smaller, is a genuine
server-side miss and stays unexplained).

## The fix

`src/providers/shims/claude/lagCacheMarker.ts` — a second marker on the message
that carried the **previous** request's marker. When the lookup from the main
marker misses, it resumes at the lag marker and finds the previous write. It
sits on bytes the server already holds, so it costs nothing (breakpoints are
free; only writes and reads bill).

- The previous marker is remembered by message `uuid`, not index: a
  `<available-deferred-tools>` prepend, stable stubs, a compaction or /clear
  leave the uuid in place or absent, and absent just means no lag marker this
  turn — no reset hook.
- A retry re-renders the same request (same last-message uuid), so the state
  rotates only when the tail changed; otherwise the retry would coalesce the
  lag into the main marker and lose the protection on the attempt that needs
  it.
- Budget: the system prompt emits up to 2 breakpoints, messages now 2, total
  the API's 4. The experimental `CLAUDIN_TRAIL_CACHE_MARKER` and
  `CLAUDIN_ANCHOR_CACHE_HEAD` would make 5 → 400, so they suppress the lag.
- `skipCacheWrite` forks are untouched (own tracking key; marker already at
  the shared frontier). Untracked sources (speculation, session_memory, …)
  get no lag — nothing to lag to.
- Tracking key shared with the break detector: `src/providers/cache/trackingKey.ts`.

The detector (`promptCacheBreakDetection.ts`) receives the marker's advance in
positions from `addCacheBreakpoints` and names the case when nothing else
explains a break: `marker advanced N positions past the last write (lookback
window is 20) — client-side placement`, or, with the lag marker placed, `… —
server-side miss`.

Alternatives considered: the API's **automatic caching** (top-level
`cache_control`) is a server-side trailing marker — it prevents the miss but
writes the mutating tail every turn, which the fork measured at +31% cost on the
1h tier (`paramBuilders.ts`, `CLAUDIN_TRAIL_CACHE_MARKER` notes). Capping the
per-request advance below 20 positions needs the same state and leaves the
tail uncached a turn longer. The **cache diagnostics beta**
(`cache-diagnosis-2026-04-07`) reports where the request *bytes* diverged; it
cannot see a lookback miss, so it is a follow-up for the server-side class only.

## Verification

`scripts/bench/ab/lookback-miss-probe.ts --bin=claudindev --reps=3` (Sonnet 5):
Read a 9.5k-char file, fourteen `Bash 'echo N'` turns, Read another. The call
after the second Read:

```
arm A (lag off)  text  in=2 cr=37951→27592 cc=16387   3/3 reps: history rewritten
arm B (lag on)   text  in=2 cr=37971→37971 cc=6104    3/3 reps: only the tail written
```

Unit tests: `lagCacheMarker.test.ts`, `__tests__/addCacheBreakpoints.test.ts`
(lag suite), `promptCacheBreakDetection.test.ts` (reason + turn line).
The census above is the before/after over real sessions; re-run it after a
week and the `marker-jump` column should go to zero while the `[Cache:]`
reasons stop saying "server-side" for these.
