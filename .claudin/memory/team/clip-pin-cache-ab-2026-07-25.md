---
name: Clip-pin A/B (2026-07-25) — dev vs stable, 30 turns, aggressive profile
description: Measured result of the READ_CLIP_PIN A/B on feat/read-clip-pin, plus the three bench-design traps (auto-outline file sizes, --revisits, the 60s Read tool-result cache) that make a naive run measure nothing
type: project
---

A/B of `claudin` (stable 1.0.16, ships the OLD counter-based `READ_RERUN_BREAKER`)
vs `claudindev` (branch `feat/read-clip-pin`, new `READ_CLIP_PIN`), Sonnet 5,
`CLAUDIN_CACHE_PROFILE=aggressive` forced on both, 10 files × 3 passes = 30 reads,
one Read per turn, n=1.

Command (flags `--files/--passes/--file-list` were added to the bench for this):

```
bun scripts/profile/cache-ab-bench.ts --a=claudin --b=claudindev \
  --model=claude-sonnet-5 --sequential --files=10 --passes=3 --runs=1 \
  --a-env=CLAUDIN_CACHE_PROFILE=aggressive --b-env=CLAUDIN_CACHE_PROFILE=aggressive \
  --file-list=<10 files, each UNDER 250 lines>
```

**Result.** Uncached input 2.348M → 2.176M (−7.3%), cost $7.72 → $7.16 (−7.2%),
wall 153s → 112s. The whole signal is in pass 3: pass 1 +65.1k/+60.3k and pass 2
+36.4k/+36.7k are a tie, pass 3 is A +15.5k vs B +2.2k. Stable re-sent ~4 full
bodies on the last 4 turns (+3.3–3.9k each); dev stayed flat (+0.2k = summaries
only), i.e. the pass-2 copy survived the age prune and the third read returned the
tiny "unchanged" stub. A constant ~4.5k of A's lead is turn-1 output noise
(A emitted 4.1k output on turn 1 vs B's 227), so treat −7.3% as directional at n=1.

**Bench-design traps (both make the feature unmeasurable if ignored):**

1. Files ≥250 lines AND ≥10k chars are intercepted by `AUTO_OUTLINE_ON_ELISION`.
   The outline marks the readFileState entry `isPartialView`, which disqualifies
   dedup outright, so the stand-down can never fire. The bench's default pool is
   size-diverse and mostly outlines — pick files under 250 lines.
2. `--revisits` only does ONE extra pass over a fixed list. The clip → re-read loop
   needs the SAME (file, range) read a third time, which is what `--passes` adds.
3. **The local Read tool-result cache (`TTL_MS.Read = 60_000`) short-circuits
   `call()` entirely.** A re-read of the same input within 60s replays the first
   read's cached body without ever running the dedup or the stand-down. This is
   almost certainly why the whole measured signal landed in pass 3 — passes 1→2
   of a 10-file cycle ran inside the TTL. Set
   `CLAUDIN_DISABLE_TOOL_RESULT_CACHE=1` on BOTH sides, or space revisits past
   60s, or the early passes measure the cache instead of the feature.
   (Fixed in the tool itself on 2026-07-25 — `FileReadTool.bypassResultCache`
   now skips the cache for any re-read of a path this context already read — so
   a fresh run should show signal earlier than pass 3. Re-bench before citing
   the −7.3% again.)

**Cache health (the question the run was meant to answer): fine, and identical on
both sides.** cache_write happens once at turn 1 (34.9k/36.9k = system+tools) and
is 0 for all 30 following turns; cache_read is that same block every turn → r:w
30:1, no prefix rewriting. BUT under the aggressive profile the growing transcript
is never cached — per-turn uncached input climbs 12k → 117k, which is where the
$7+ per side came from. Only the static head is cached, because clipping mutates
message blocks and no message-level cache marker can survive past the clip
frontier. Under the default `auto` (→ retain on Anthropic) that shape differs.
