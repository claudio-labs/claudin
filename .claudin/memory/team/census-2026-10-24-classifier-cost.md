---
name: census-2026-10-24-classifier-cost
description: Census A=10-20..23 vs B=10-23..24 — the auto-mode classifier is ~24% of all spend ($53 of ~$220 in B), 90% of it cache writes from a transcript window that slides every call (fixed on perf/census-2026-10-24); session-census.ts priced Opus 5.5 and Haiku 5.5 ~2x too high (fixed); own-writes names-only passed every check; cache healthy
type: project
---

Windows are local days (UTC−3): A = 10-20T03Z..10-23T03Z, B = 10-23T03Z..10-24T15Z.
Bench dirs (`-tmp*`) and the census session were left out. Method: one scratchpad walk
that dedupes tool_use by id and messages by id, main files first, with calls bounded by
their own timestamps. The B dollar figures use the app's prices (`modelCost.ts`).

**session-census.ts over-reports about 2x.** Its `PRICES` mirror has no Opus 5.5 row, so
`opus-5-5` matches the Opus 4.5/5 row ($5/$25, read $0.50) where the app charges
$4/$20, read $0.20. `haiku-5-5` falls to the generic `/haiku/` row ($0.8/$4) where the
app charges $0.1/$0.5. For B it reported $327; the app-priced transcript total is $159.
Every census since Opus 5.5 became the default carries the same inflation. Its ratios
still hold. The file's header said importing `modelCost.ts` now loads; it does not. The
Opus 5.5 fast-mode check reads the config and throws in a bare script. Fixed on branch
`perf/census-2026-10-24`: the rows are added, a test compares them with
`getModelCosts`, and the header is corrected. `forkBench.ts` and `relief-ceiling-sim.ts`
had the same gap.

**The auto-mode classifier is the largest lever found.** Data from `cost-state.sourceUsage`
for the 4 B sessions that carry it: `auto_mode` was $53.39 over 625 calls, and
`repl_main_thread` was $132.34. In the long ferrous-dns session 4c2d912b the classifier
cost $30.35, which is 62% of that session's main thread ($49.25).
- About 90% of it is cache writes at the 1h price: 3.56M write tokens for 226 calls in
  4c2d912b, against 1.21M for the main thread itself.
- Output is about 45 tokens per call, so the stage-2 thinking pass is rare and is not
  the driver.
- Cause: `serializeTranscriptForClassifier` (`yoloClassifier/transcript.ts`) fills from
  newest to oldest up to `MAX_CLASSIFIER_TRANSCRIPT_CHARS` (200k). Past the cap, the
  oldest kept entry moves on almost every call. The prefix after the CLAUDE.md block
  then changes, and the whole transcript block is rewritten.
- Per-call writes: 15.7k in 4c2d912b and 14k in 2300d5a2 (long sessions, past the cap);
  1.2k in 744a8a85 (short session).
- The classifier model is `getMainLoopModel()`, so Opus 5.5 also classifies for Haiku
  sub-agents. Explore agents sent 261 of the 668 classified tool calls in B, while their
  own spend was $1.36. **Corrected the same day:** in the replay, a sub-agent's
  classifier call writes ~0.2k tokens, about $1-2 over two days. Its own short transcript
  stays cacheable, so this is not a lever.
- 595 of the 1,050 Bash calls in B went to the classifier. Of those, 202 expand a shell
  variable (mostly `S=<scratchpad>; … $S/…`), 118 use `$(…)`, 91 start with a redundant
  `cd <project root>`, and about 87 are plain read-only pipelines. **Corrected:**
  resolving literal `VAR=` assignments and dropping `cd <root>` would make only ~22 of the
  595 provably read-only. Not worth touching `bashPermissions/`.
- **Fixed** by the stable cut ([[classifier-transcript-stable-cut]]): −75% writes per call
  in the replay.

**Own-writes names-only (10-21) passed** ([[own-writes-next-census-checks]]):
- `edited_text_file` notes fell from 32.9 to 7.6 per 1k calls.
- After 59 claims (Git stash/fetch/checkout, formatter, build, break-probe, Patch), the
  claimed path was Read again within 3 calls only twice, and no Edit or Patch missed.

**Tool errors:** 1.0% in A and 1.2% in B (37 of 3,041).
- Git is worst at 8 of 137. Five of those are `git pull` or `git switch` refused for a
  dirty tree, where the only dirty file was written by the harness: the map-synced
  `.claudin/rules/search-strategy.md` 4 times, and team `MEMORY.md` once. It happened in
  both repos and recurs from 10-19. The 4 map cases are fixed by the Git tool's set-aside
  ([[rule-map-end-of-turn]]). The `MEMORY.md` case was a real uncommitted edit, so it stays
  an error.
- Other errors: Grep given a stale pre-reorg path (`src/utils/…`) and two paths in one
  `path` string; an rg look-around regex without `--pcre2`; Glob called with Grep's
  `no_ignore`; a Patch with a repo-relative path after the shell cwd had drifted into
  `web/static`.
- The 10-19 expected zeros held: no `[clipped:` echo (all 21 hits were text about the
  placeholder), and no `gh pr checks` error.

**Cache is healthy.**
- Uncached tail: 0.
- B had 4 rewrites: 3 after idle periods over 1h, including two sessions resumed together
  on 10-24 at 14:06, and 1 relief clip.
- The main thread at app prices was $147: reads $92, writes $30, output $25. Context p50
  was 360k and p90 630k, and 813 of 1,271 main calls were over 300k. Context size is
  still the cost. Lowering when it gets relief was measured the same day and not
  promoted ([[large-window-compaction]]).

**Read and search:**
- Re-reads with no write in between were mostly a different range. Only 87 had the same
  arguments, and 80 of those were one memory-sorting sub-agent reading the same team
  files again 4 minutes later.
- Read-backs after the model's own write fell from 67 to 18.
- Multi-Read is 11% of Reads and 43% of Read chars (p90 46k).
- Through Bash: git diff/show was 110 calls and 488k chars, mostly piped. `sed -n` was
  113 calls and 338k chars.
