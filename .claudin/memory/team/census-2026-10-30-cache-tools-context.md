---
name: census-2026-10-30-cache-tools-context
description: Census 10-25..30 (claudin + ferrous-dns, Opus/Haiku 5.5 only) — cache clean (11 rewrites, all idle/clip/5m TTL, tail 0); #321 classifier writes/call −67% live (14.2k→4.6k); tools 1.1%; zero compactions; map set-aside skips a multi-file dirty tree
type: project
---

Window 2026-10-25T03Z → 10-30, record timestamps, `-tmp*` and the census session left out.
12 main threads (2,112 calls, 1M window) and 51 sub-agents. No Gemini or other provider
traffic: the native-transport work ran on Opus, and `…worktrees-gemini-native-ci` has no
transcript.

**Cache: no break.** 11 rewrites: 9 idle >1h on main (3.14M, $25; 3 of them resumes), 1 relief
clip (6e300fb6 10-28T17:58Z, freed ~331k, rewrote 390k, $3), 1 Haiku sub-agent 5m TTL lapse.
Uncached tail 0 (max `input_tokens` 4), "mutated at 14" and media-cap rewrites 0,
`prefix_binding_mismatch` only on the rewrite calls. Main $253 over 5 days ($51/day vs $73):
reads $148, writes $64, output $41.
- Mislabel: that sub-agent's `[Cache:]` line said "likely server-side (<5min gap)" for a
  5m45s gap on a 5m TTL.
- 6e300fb6's 10-28 segment logged 282 s of retry wait; the transcript does not say why.

**Classifier stable cut (#321) verified live:** 14.2k → 4.6k writes/call (−67%, replay said
−72%), $0.124 → $0.048/call, 31% → 19% of segment spend
([[classifier-transcript-stable-cut]]). Split by segment start against the merge, because
every transcript record says `"version":"unknown"` (true since at least 10-03), so a census
cannot tell which binary ran.

**Tools: 54 errors in 4,876 calls (1.1%)**, Git worst at 19/382 (11 real git failures). All
10-15/10-19 expected zeros held, except 3 Edit/Write read-gate refusals on files never or
partly read (legitimate gates). New: Read's "limit applies to one file" refusal; 6
response-chain skip cascades. One classifier denial (4ab77f00 10-27T01:21Z,
`python3 post.py --dry-run`) gave a false reason ("contents never appear in the
transcript") for a file written in the same response.
- Dirty-tree refusals: 2 (6e300fb6 10-28). The map set-aside did nothing because it only acts
  when `search-strategy.md` is the single dirty file (`ruleMapAutoSync.ts`), and team memory
  notes were dirty too. The model recovered with `--autostash`.

**Context: zero compactions** (auto, `/compact`, starved), no overflow, no `max_tokens`, no
complaints after a clip. 7 idle-gap clips. Main p50 332k, p90 628k, peak 732k; 57% of calls
over 300k.

**A 1h-tier keep-alive on main does not pay** (`scratchpad/cache/keepalive2.ts`). Pinging
every 55 min would have avoided 6 of the 9 idle rewrites: +$13.9 gross. But a warm cache stops
the idle-gap clip, so later calls read the pre-clip context. The extra reads cost $13.5, which
leaves +$0.59 net over 5 days. It only pays where the idle clip frees little (the three
6e300fb6 gaps, +$9.7).

**Fixed on `fix/census-2026-10-30`** (one red commit, then a fix per cause):
- **`"version":"unknown"`.** Four sites guarded with `typeof MACRO`, and the build defines only
  the dotted `MACRO.*` keys, so the guard is false in every binary. The sites were the
  transcript, the doctor, the insights export and the xAI UA (`claudin/dev`). They now go
  through `getDisplayVersion()` (`platform/buildVersion.ts`), which reads
  `MACRO.DISPLAY_VERSION`, and `src/__tests__/macroGuard.test.ts` bans the guard. Checked live:
  a new transcript says `"1.1.49"`, and the doctor says `development (1.1.49)`. A dev build
  records the last release's number.
- **Classifier blind spot.** Tools run with `context.messages = messagesForQuery`
  (`agent/query.ts:406`). The calls the response made before the one being judged now follow
  the history (`earlierCallsOfResponse`), one entry each, matching the bytes of the next
  turn's history. `CLAUDIN_CLASSIFIER_RESPONSE_CALLS=0` turns this off. Checked live: the debug
  line says `pending=1` for a Write followed by a Bash in one response, and `pending=0` with
  the killswitch on.
- **Dirty tree.** The Git diagnosis names `git pull --autostash` for a merging pull that would
  overwrite, and `git rebase --autostash` for a rebase.

**Follow-ups, each for its own branch:**
- **Retry reasons.** `withRetry.ts:377-397` sleeps without yielding, and `:531` yields only SDK
  errors. The file is at 11% coverage.
- **Classifier lag marker.** The 63f9fd14 outlier is not a leak. A replay put chunk moves at
  362k and lookback misses at 230k; the misses come from 33-128 blocks between decisions, past
  the 20-block lookback. The request carries 3 breakpoints, so the 4th is free. This is a cost
  lever and needs a replay and an A/B with a placebo. The replay under-predicts live usage by
  2.2x, and that gap is still unexplained.
- **The `[Cache:]` "<5min" label.** The gap clock is start-to-start of real requests, and pings
  never touch it, so a 5m45s gap cannot produce that label. Not reproduced.

**How to apply:** use this as the baseline for the next census. Expect the transcript `version`
to be filled in, and no dirty-tree refusal that the model has to solve with an `--autostash`
of its own.
