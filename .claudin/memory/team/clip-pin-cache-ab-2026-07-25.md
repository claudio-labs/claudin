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
bun scripts/bench/ab/cache-ab-bench.ts --a=claudin --b=claudindev \
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

> **STALE — do not cite this number.** Measured at `f595ba5`. Every review round
> since changed the measured path materially, not cosmetically: the stand-down
> now consults the clip registry (so it fires in cases this run never reached),
> a `STAND_DOWN_STRIKES` bound applies even with the pin disabled (so arm A's
> behavior changed too), and `bypassResultCache` altered disk IO on both arms.
>
> The design then changed twice more on 2026-07-25. First: pin-plus-re-arm never
> terminates (~2 full bodies every 4 reads), so the fallback started leaving a
> **sticky** `standDownOutline` marker on the readFileState entry. Then a second
> three-agent review found that a PERMANENT marker deadlocks Read against
> Edit — it sets `isPartialView`, so the edit tools refuse, and the replay never
> rewrites the entry that would lift the refusal. Final shape: the marker is
> budgeted (`STICKY_REPLAY_BUDGET`), re-arming with a real body once per budget.
>
> Do not guess the direction of the saving either. An earlier note here claimed
> it must be "strictly larger" than −7.3%; that is unsupported — the old regime
> answered the third read with a tiny unchanged stub, and an outline plus
> redirect footer is bigger than that stub. Re-run from scratch.
>
> The **bench-design traps below are still valid** and are the reusable part.

**Re-run 2026-07-25 (at `0b02d8f` + the view/symbol + handover tests): INCONCLUSIVE,
and that is the durable finding.** Same command as above plus
`CLAUDIN_DISABLE_TOOL_RESULT_CACHE=1` on both sides (trap 3), 10 files of 236-240
lines. A (claudin 1.0.16) $5.99 / 134.8s / cR 1.09m / cW 36.2k; B (claudindev)
$6.09 / 121.5s / cR 1.15m / cW 38.2k. B is **1.8% more expensive**, and none of
that is the feature:

- **No clip ever fired, so no stand-down could.** Both session transcripts contain
  ZERO clip/stub markers and exactly the 20 ordinary `file_unchanged` dedup stubs
  that passes 2-3 should produce. The timeline says the same thing: uncached input
  climbs to ~70k over pass 1 (10 bodies) then grows ~0.2k/turn for the remaining 20
  turns — no ~4k body is ever re-sent, on either arm.
- **Trap 3 is self-defeating for the dev-vs-stable comparison.** The old −7.3%
  came from pass 3 falling OUTSIDE the 60s Read TTL, where stable's old breaker
  re-sent 4 full bodies. Disabling the tool-result cache — which trap 3 tells you
  to do — removes exactly that asymmetry: every pass now reaches `call()`, dedup
  answers correctly on both arms, and there is nothing left to differ.
- **The whole 1.8% is a constant 2.0k larger system+tools block** (cW 36.2k → 38.2k)
  billed as cache_read on all 30 turns (+60k). That is NOT attributable to the
  branch: A is the published npm 1.0.16 and B is main+branch, so the delta is
  everything since the release. To cost the branch itself, A/B the SAME binary with
  `--a-env=CLAUDIN_DISABLE_READ_CLIP_PIN=1` (the killswitch leaves the prompt text
  in place, so cW is identical and only behavior differs).
- **Open question for the next design:** why 70k of pass-1 bodies survive under
  `aggressive` (`keepTurns=1`) when `pruneOldToolResults` runs on every `role:'user'`
  message and tool_results are role user. Until that is answered, assume a headless
  `-p` file-reading workload does not clip and pick a workload that provably does.

**Bench-design traps (each makes the feature unmeasurable if ignored):**

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
   (Partly fixed in the tool on 2026-07-25 — `FileReadTool.bypassResultCache`
   skips the cache for a re-read whose stand-down could fire, i.e. when the
   prior tool_result is clipped/missing or the API has cleared in this session.
   A re-read with an intact prior result still hits the cache by design, so the
   bench flag is still required. Re-bench before citing the −7.3% again: the
   fix changes disk IO on both arms.)

**Cache health (the question the run was meant to answer): fine, and identical on
both sides.** cache_write happens once at turn 1 (34.9k/36.9k = system+tools) and
is 0 for all 30 following turns; cache_read is that same block every turn → r:w
30:1, no prefix rewriting. BUT under the aggressive profile the growing transcript
is never cached — per-turn uncached input climbs 12k → 117k, which is where the
$7+ per side came from. Only the static head is cached, because clipping mutates
message blocks and no message-level cache marker can survive past the clip
frontier. Under the default `auto` (→ retain on Anthropic) that shape differs.
