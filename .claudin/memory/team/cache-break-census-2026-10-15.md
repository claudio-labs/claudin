---
name: cache-break-census-2026-10-15
description: Cache-break census 10-08..15, all projects (~$2.3k) — the new leak is the uncached tail from image blocks pinning the clip frontier ($243); sub-agent 5m expiries are gone after PR 280; post-280 relief clips on 1M free ~130-160k and rewrite ~600k each (9 clips, ~$54); idle>1h expected; no turn-opening thinking-drop rewrites
type: project
---

Asked 2026-10-15: "do we still have cache breaks?" Method: `lookback-miss-census.ts
--since=7 --verbose`, plus `session-census.ts --since=2026-10-08` per project
(claudin $1,246, ferrous-dns $795, infra-home-lab $292). A throwaway scan of
every transcript summed `input_tokens` and `input_transformations` per session.
The lookback census reports 47 events, 16.1M of 33.7M writes.

- **New: uncached tail, $243.** Image blocks pin the clip frontier, so the tail
  is never cached. Details in [[clip-frontier-stalls-on-image-blocks]].
- **Sub-agent TTL expiries are gone.** Last week they were $592. This week there
  was one sub-agent drop in all three projects (cf3ad806/sub on 10-09, before
  the PR 280 binary).
- **Relief clips on 1M, 16 events, 9.6M.** 8 are pre-280 (f46c4a97 and 85a6c4ac
  on 10-09/10, already in [[ttl-expiry-check-2026-10-12]]). The 9 after it
  (e646e084 ×4, b985a729 ×3, 58d2de59, and 3e9f7e6e at 10-15 17:01, whose line
  was not written yet) each freed one band (133-159k), rewrote 560-690k, and
  cost ~$54 in total. That is by design. Three of e646e084's clips landed in
  14 minutes, behind single results of up to 159k. None was followed by a
  next-turn floor, and no starved compaction appeared.
- **Expected:** 14 rewrites after an idle gap over 1h (3.06M).
- **Noise:** the 3 bench sessions on 10-09 21:1x (50k each), 15d4e873 "likely
  server-side" (39k), one 8cbbe1d6 marker-jump (86k).
- Thinking drops (`prefix_binding_mismatch`) recur on every request after a
  clip in all the big sessions. The cache stays fine (`in`≈2), and no
  turn-opening #273-type rewrite was found.

**How to apply:** check `input_tokens` along with read/write drops in a cache
census. Before 10-15, every detector ignored it. Since the
fix/cache-image-frontier branch, `lookback-miss-census.ts` prints an
"uncached tail" section, and the `[Cache:]` line names one.
