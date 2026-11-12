---
name: census-2026-11-11-classifier-chunk-moves
description: Census 11-04..11 (claudin + ferrous-dns) — the main cache is clean (16 full rewrites, all explained); the classifier is 15% of spend and 62% of what it writes is the stable cut moving, 13% lookback misses; window budget + lag marker −32% in replay and all six live gates in both reps, shipped opt-in; read-slice levers have no headroom (0.1% of calls); a 1h keep-alive nets +$1.5/week at Opus 5.5 prices, +$9 at Fable 5.2; /cd left instructions, git status and branch stale (fixed)
type: project
expires: 2027-01-10
---

Window 2026-11-04 → 11-11, claudin and ferrous-dns, the census session left out. Every session
in it ran v1.1.51, so #346 and #347 have no field data yet: the next census is their first.

**Spend, $568 over the whole sessions active in the window (cost-state `sourceUsage`):**

| Source | $ | share | per call |
|---|---|---|---|
| main thread | 396 | 70% | $0.105, average context 320k |
| auto-mode classifier | 85 | 15% | $0.047 over 1,803 calls, 75% of it cache writes |
| Code / Explore sub-agents | 45 / 4 | 8% / 0.7% | |
| auto_dream | 17 | 2.9% | ~$3.3 a run, reads ~120k a call |
| agent_summary / extract_memories | 9 / 6 | 2.7% | |

**Main-thread cache: nothing new.** 16 full rewrites in 8 days, each explained: 10 idle >1h
(2.2M tokens), 4 relief clips, the Esc break #346 fixed, one model switch. No uncached tail, no
compaction, no overflow; context p50 198–264k, p90 415–608k.

**Classifier: the cut moving is most of what it writes.** `classifier-cache-replay.ts` over the
window (1,646 calls, 4.33M tokens written under the stable cut):
- 62% is the cut moving a 25k chunk and writing the ~175k it keeps again (59 moves);
- 13% is a lookback miss: more than 20 blocks since the last judged call (Read, Grep and Glob
  add blocks without a classifier call), so the lookup falls back to the CLAUDE.md breakpoint;
- 6% idle >1h, the rest plain appends.

Either fix alone is worth 5–7%, because a whole transcript turns every lookback miss into a
full rewrite. Together: −32% of the classifier's cost at Opus 5.5 prices, −42% at Fable 5.2
($16 a 1h write, the same $0.20 read). Status and the live run are in
[[classifier-transcript-stable-cut]].

**Read slices: no headroom.** 86% of main Reads are ranges and 36% are a third or later slice of
the same file, but only 5.4% of API calls are a range Read alone in its request. Replayed
(`reread-census.ts --levers`): bodies on a content Grep, a small range widened to its symbol and
the whole file on a third slice save 0.1%, 0.0% and 0.1% of calls, each a net loss once the
lines returned unasked are priced. None built. `symbol`, Grep `symbols`, LSP and Rename had 0
uses in the window.

**Keep-alive on the 1h tier: a sign, not a size.** `keepalive-sim.ts`, 8 expiries, 5 covered,
in two sessions: K=2 pings net +$1.5 a week at Opus 5.5 prices and +$9 at Fable 5.2 (1.9% of
main spend), because the extra reads a lost idle-gap clip costs are the same dollars on both
and the avoided write doubles. Not implemented.

**Fixed on `perf/census-2026-11-11`:**
- `/cd` (and `/memory`, a worktree, a restore) cleared the file cache and not `getUserContext`'s
  memo, which `claude_md_delta` compared: the model was told the new directory and kept the old
  one's AGENTS.md, rules and memory indexes until a compaction. The delta reads the files now;
  the classifier's copy follows it. The git status snapshot is dropped and announced again for
  the new directory.
- Found live while checking that: the git file watcher (branch, HEAD, remote, default branch) is
  started once and only re-reads when the FIRST repo's files change, so the new snapshot went
  out under the old branch and the footer pills kept it. `rerootSession` resets it.
- Git: a refused batch says nothing ran (11-10: the model re-sent the fixed command without the
  `git add` before it). Batch Read: a missing symbol lists the file's symbols. Grep: a cut page
  names the next offset. Glob: `.git` is pruned unless the pattern names it.
- The census and fork-bench price mirrors had no Fable 5.2 row (it fell to Fable 5's, read $1.00
  for $0.20); their tests now walk every model in `configs.ts`.
- The team index was 12 bytes under its 25,000-byte cap; trimmed to 24.8k without dropping an
  entry. Most of its length is link targets on grouped lines.

**Checked and not true:**
- "Server `clear_tool_uses` is on by default": `cli.tsx` sets
  `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS ??= 'true'`, which turns it off.
- "Bash's read-only check lets too much reach the classifier": fixing the three false positives
  (`'foo$'`, `--include=*.ts`, a leading `cd`) frees 4 main calls a week of 1,382 judged.

**Open, read in the code and not reproduced:** EnterWorktree and ExitWorktree change directory
without `resetGitFileWatcher()`, so the branch and PR pills there may be the main checkout's.

Break-probes: `census1111.json` (25) and `classifierWindowLag.json` (23). The first pass turned
nothing red on nine lines: eight got a test, and one was dead code and was removed.
