---
name: session-cache-ab-bench-2026-09-23
description: Session cache A/B (claudindev vs Claude Code 2.1.280, Opus 5.5, two-prompt session with a --resume, N=3) — claudindev went from +53% to +7% (overlap) after fix/session-cache: resume 40%→100% read-back, cost −27% SEPARATED
type: project
---

`scripts/bench/ab/session-cache-ab.ts` (fixture in
`__fixtures__/session-cache-ab/`, `.tpl` so the repo's `bun test` skips it): a
TypeScript pricing engine, prompt 1 = two features + a bug fix with tests,
prompt 2 = `--resume` in a new process + a third feature + commit. Hidden
black-box acceptance tests grade every phase; `--dry-run` proves the grader
(pristine 0/18, reference solution 18/18). `--variant=<label>:ENV=VAL` adds a
claudindev arm with a killswitch set; `--replay=a.json,b.json` merges runs, and
`--replay=new.json@after,old.json@before` keeps the same arm from two runs apart.
`RESUME_DIFF_RUN=<run dir> bun test scripts/bench/ab/resume-transcript-diff.test.ts`
diffs each recorded session's live vs resumed rendering offline.

**Result 2026-09-23, 3 reps, all 6 runs 18/18 + committed** (median):

| | claude | claudindev |
|---|---|---|
| API calls | 18 | 24 (SEPARATED) |
| first-turn context | 21.2k | 32.1k |
| cache read / write | 872k / 62.9k | 1.34M / 101.4k |
| uncached input | 36 | 40.1k |
| cost (one price table) | $1.23 | $1.88 (+53%, SEPARATED) |

The +$0.65 gap: resume re-write $0.29 ([[resume-rewrites-cache-prefix]]),
uncached tails of the deferred marker $0.16, more reads $0.09, more output
$0.12. Claude Code 2.1.280 sends 16 tools / 26.9k chars (no Grep/Glob, edits
via python heredocs in Bash); claudindev 38 tools / 100.6k chars (Agent alone
11.4k).

**Variants (N=3, same day):** `CLAUDIN_DEFER_CACHE_MARKER=0` removed the
uncached input entirely and cost −4% (SEPARATED, $1.80 vs $1.88); on Opus 5.5
with 1h TTL the small per-turn writes Claude Code makes (555–774 tokens) ARE
stored and read back — the ~1024-token floor behind [[defer-cache-marker-shipped]]
did not show up here. `CLAUDIN_DISABLE_BASH_FILTER_CAP=1` cut tool calls −24%
(SEPARATED) but let `cat` dumps through: tool-result chars +79%, cost +19%
(overlap) — keep the cap.

**Bash filter:** it fires on 35% of claudindev's Bash calls (−93% of their
chars), but what it cuts is `cat`/`for … cat` file dumps capped to 15+15 lines
(`FLOOR_CAP_LINES` 60), which the model then re-reads with Read. Replayed over
Claude Code's Bash, it would remove 42.5% of the chars, mostly the same dumps.

Also seen: claudin's `num_turns` counts tool-result messages
(`QueryEngine.ts` `turnCount++` per user message: 36 reported for 17 calls);
`total_cost_usd` after `--resume` is per process in claudin but cumulative in
Claude Code; `ruleMapAutoSync` + memory dirs leave `?? .claudin/` in the
user's tree and the model spent a Bash call reading it.

**After `fix/session-cache` (same A/B re-run 2026-09-23, both arms, N=3, all
6 runs 18/18 + committed):** resume persistence and parallel-result order
([[resume-rewrites-cache-prefix]]), marker default 0
([[defer-cache-marker-shipped]]), four zero-use tools deferred
([[request-prefix-size-2026-09-23]]).

| claudindev, median | before | after |
|---|---|---|
| resume: prefix read back | 40.4% | 100% (SEPARATED) |
| resume-turn cache write | 38.0k | 1.1k |
| lost prefix tokens / cache breaks | 40.9k / 1 | 0 / 0 |
| uncached input | 40.1k | 52 |
| first-turn context | 32.1k | 30.4k |
| cache write | 101.4k | 65.5k (−35%) |
| cost | $1.88 | $1.37 (−27%, SEPARATED) |

Claude Code in the same run: $1.28 (control, +4% vs its morning run, overlap),
so the gap went from +53% SEPARATED to +7% (overlap). What remains is more
cache reads (+46%, more tool calls: Read ×23 vs Claude Code's `cat` batches)
and output (+6%). The first re-run, before the parallel-order fix, still read
back 41%/60%/100% — see the bug memory for how it was found.
Runs: before `/tmp/session-cache-ab/20260923-042026`, after `-062408`.
