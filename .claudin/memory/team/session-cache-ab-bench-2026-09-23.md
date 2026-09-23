---
name: session-cache-ab-bench-2026-09-23
description: Session cache A/B (claudindev vs Claude Code 2.1.280, Opus 5.5, two-prompt session with a --resume) — +53% → +7% after fix/session-cache (resume 40%→100%); round 2 found the N=5 noise floor (a placebo arm moved cost −6%) and a time-of-day drift (main +12% by afternoon), so compare only simultaneous arms
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

Also seen: `num_turns` counts every user message, tool results included
(`QueryEngine.ts` `turnCount++`) — the same rule as Claude Code 2.1.280's
binary; claudin's is higher because each parallel result is its own message
(kept as is). `total_cost_usd` after `--resume` was per process in claudin but
cumulative in Claude Code — FIXED in round 2 (a `cost-state` transcript
entry). `ruleMapAutoSync` + memory dirs leave `?? .claudin/` in the user's tree
and the model spends a Bash call reading it — by design (the repo map is meant
to orient the model).

**After PR #239 (`fix/session-cache`; same A/B re-run 2026-09-23, both arms, N=3, all
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

**Round 2 (`perf/session-cache-round-2`, run `-155324` @3a4eaa21, N=5,
claudindev arms only, all 20 runs 18/18 + one conventional commit, no AI
trailer):**

| median | claudindev | readcat | credit | lean |
|---|---|---|---|---|
| turns | 23 | 19 | 19 | 23 |
| tool calls | 43 | 36 | 38 | 41 |
| first-turn context | 29,436 | = | = | 28,375 (SEPARATED) |
| cost | $1.60 | $1.54 (−4%) | $1.50 (−6%) | $1.51 (−6%) |

- The branch baseline opens 1.0k below #239's 30.4k: in `-p` the Agent
  description and the system prompt stop teaching the hidden
  `run_in_background` (unflagged).
- **`credit` was a placebo** — its credit let no edit through in 10 runs — and
  still moved turns −17%, cost −6%: that is this bench's noise floor at N=5.
  `readcat` passed its median gate inside that band and was not promoted
  ([[bash-read-passthrough-not-promoted]]).
- `lean` (git + agent text) met its gate: first turn −1,061 (probe −1,227
  ±300), cost ≤ baseline +3%. Both lean texts are the default since (the
  Agent half also passed [[delegation-steer-ab-2026-09-23]]).
- Every claudindev run's resumed process now reports the whole session's
  `total_cost_usd`, equal to the priced cost.
- This run's baseline paid $0.69 of output against −062408's $0.58 on the
  same prompts: output swings ~20% between runs — compare arms within a run.

**Final round + the time-of-day trap (same day).** Claude Code vs the final
branch build (`-175528` @7c5782af, N=5): $1.25 vs $1.64, +32% (overlap), where
the morning's `-062408` had said +7%. Claude Code stayed flat all day
($1.28 → $1.25) while every claudindev arm cost more in the afternoon — so
main and the branch were run SIMULTANEOUSLY (`-182338` main build via
`--bin-claudindev`, `-182346` branch, merged with `--replay=…@main,…@branch`):

| median, N=5 each | main | branch |
|---|---|---|
| cost | $1.53 | $1.65 (+8%, overlap) |
| first-turn context | 30.4k | 28.4k (SEPARATED) |
| turns | 24 | 21 (SEPARATED) |
| output | 31.9k | 39.8k (+25%, overlap) |
| cache read | 1.46M | 1.22M (−16%, overlap) |

Main itself went $1.37 → $1.53 between morning and afternoon, so most of the
+7% → +32% is time of day, not the branch. Read a cross-CLI gap only from arms
run at the same time; a claudin-vs-claudin question needs its own simultaneous
arms. The branch's output (+25%: fewer turns, bigger patches) is the number to
watch next. In 3 of 5 final-round runs an ~8k-char multi-file patch was refused
because README.md had only been `cat`'d (and capped) — the model re-sends the
whole patch, a recurring output cost on both builds.

**Why Claude Code is still cheaper — `-175528` decomposed offline (no new
runs), cross-checked on `-062408`.** With no cache breaks, a token that enters
the context at call k costs one write plus one read per later call, so the
priced cost splits exactly (reconstruction within $0.0002 per run). Thinking is
the API's own count, `usage.output_tokens_details.thinking_tokens`: per message
in claudin's stream-json, per process in Claude Code's `result` (its
`result.usage` is per process after `--resume`, unlike `total_cost_usd`).
Estimating it as output minus visible chars / 2.22 overshoots both arms by
1–2k but keeps the ratio.

| per session, mean | Claude Code | claudindev | Δ |
|---|---|---|---|
| hidden thinking | 5.6k tok, $0.17 | 10.6k, $0.32 | +$0.15 |
| patch re-sent after the read gate | 0 | 2.6k, $0.08 | +$0.08 |
| other visible output (code + text) | 22.5k, $0.66 | 22.3k, $0.66 | +$0.01 |
| prefix, read on every call | 21.2k, $0.17 | 28.4k, $0.21 | +$0.05 |
| tool results + reminders | $0.29 | $0.32 | +$0.03 |
| total | $1.28 | $1.59 | +$0.32 |

- Editing costs the same ($0.78 vs $0.76, re-sends included). The gap is the
  non-edit steps: 13.8 turns vs 5.4, $0.74 vs $0.40 (output +$0.20, turn tax
  +$0.10, results +$0.03). Claude Code reads the project in two `cat` calls and
  chains `bun test` into other commands; claudindev spends ~5 turns reading
  (an `ls .claudin` detour, a `cat` the filter caps, Read×12, Read×7), runs
  RunTests/Typecheck alone twice, and re-orients after `--resume` in 1.4 turns
  ($0.18) against 0.8 ($0.06). Claude Code's Bash-only shape is steered: its
  `auto_mode` attachment carries `bashFirst:true`.
- Thinking is 1.3–1.9× Claude Code's in every simultaneous run (7.0–10.6k vs
  5.4–5.6k), 24–30% of claudindev's output against ~20%. Claude Code's is flat
  within a run, not across runs: round 3 saw it move 4.8k → 7.1k in 26 minutes
  ([[session-cost-round-3-2026-09-23]], which also tested every candidate below).
- Read gate: 24 of 63 claudin sessions of the day (38%, 0–100% per run) got
  "has not been read yet" on README.md and re-sent the whole patch, ~2.9k
  output tokens (~$0.10) per refusal.
- **Effort is at parity here, so it is not the thinking gap.** A mock capture of
  a two-phase session with the bench's flags shows `output_config.effort:"high"`
  on every request of both CLIs, after `--resume` too; Claude Code repeats it on
  its role:system environment message, and its transcripts record
  `effort:"high"` on every assistant entry. What else differs on the wire:
  `thinking.display` updates vs omitted (`CLAUDIN_THINKING_DISPLAY=updates` is
  a one-env variant arm), per-turn-control and mid-conversation system messages
  (not in claudin), `block_binding`, a 6.3k vs 20.2k-char system prompt, 16 vs
  38 tools. None is pinned yet. Without the flag Claude Code sends `medium` on
  Opus 5.5 and claudin `high`, a gap this bench does not measure.
- Not causes: the cache (100% resume read-back, 0 breaks) and tool-result
  volume (27–29k tokens vs 25–27k).
