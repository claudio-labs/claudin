---
name: cat-read-and-batch-read-ab-2026-09-24
description: A/Bs (N=5, 2026-09-24) of "a whole cat counts as a read" (CLAUDIN_BASH_READ_CREDIT + PASSTHROUGH) and the batch Read (CLAUDIN_READ_MULTI) on perf/cat-read-and-batch-read — batch Read PROMOTED (per-file hooks) and ties Claude Code ($1.04 vs $1.04); catread, even with cd/head/tail, adds +6% on top of it and stays off
type: project
---

Run `/tmp/session-cache-ab/20260924-212723` (`session-cache-ab.ts --reps=5
--effort=medium --proxy`, build 1a1f9ca6, Claude Code 2.1.281, all five arms
simultaneous; 25/25 sessions 18/18 + one commit). Why they exist: the 09-24
section of [[session-cache-ab-bench-2026-09-23]] — claudin spent 4 reading
turns and ~17 Reads where Claude Code `cat`s the project in 2–3 calls and
edits without a Read.

| median [min–max] | claude | claudindev | catread | readmulti | placebo |
|---|---|---|---|---|---|
| cost | $0.947 | $1.127 [0.94–1.36] | $1.021 [1.00–1.23] | $1.136 | $1.169 |
| API calls (turns) | 14 | 19 [16–28] | 18 [16–22] | 16 [13–21] | 20 [18–26] |
| turns before the 1st edit | 3 | 4 [4–6] | 4 [3–6] | 3 [3–4] | 4 [3–7] |
| tool calls | 12 | 34 | 20 [15–31] | 16 | 36 |
| Read calls | 0 | 19 | 1 [0–15] | 3 (2–3 batches, 7.3 files each) | 18 |
| output / thinking | 21.0k / 2.2k | 25.4k / 4.4k | 22.6k / 4.3k | 22.6k / 3.8k | 23.3k / 4.3k |
| tool-result chars | 40.8k | 45.9k | 48.5k | 46.3k | 58.4k |

- **catread**: the credit engaged in 4/5 runs (13–28 files credited, zero
  Reads of a credited file, edits accepted with no Read). Gates: mechanism,
  quality and "no `.claudin/memory` detour" pass; "turns before the 1st edit
  −1" fails (4 vs 4) and "tool-result chars ≤ baseline" fails (+6%). Cost −9%
  while the placebo moved +4% — inside the ±6–16% noise.
  - Where it did not engage, the grammar refused the command: `cd src && cat …`,
    a chain whose trailing `ls tests*` failed and made the run an error, and
    `head -c` beside a test loop (after the model followed a `Not shown` line).
    Next lever: a leading `cd`, and `head`/`tail` as partial prints.
- **readmulti**: used in every run; API calls −3 (−16%) with the placebo going
  the other way — the user's criterion. Cost flat: it read 22 distinct files
  against 19, and its Patch re-sends were ordinary context/order errors.
  A census of 156 real sessions put its ceiling at ~1.9% of API calls (73% of
  Read-only messages read one file); this bench is orientation-heavy.
- The `.claudin/memory` detour is gone in every claudin arm (2/5 before): the
  memory section now says when both indexes are empty.
- Thinking stays ~2× Claude Code's in every claudin arm; nothing here touches it.
- Proofs kept: `scripts/bench/ab/read-credit-e2e.ts` (mock model, 17 checks),
  `scripts/migrations/probes/catAsRead.json` (96) and `readMulti.json` (97).
- Promotion: the user promoted the batch Read, conditioned on per-file hooks
  ([[batch-read-default-on]]), and sent catread back for `cd` and `head`/`tail`.

**Round 2 — batch Read on by default, catread with `cd` + `head`/`tail`** (run
`/tmp/session-cache-ab/20260924-231111`, build d444c515, 4 simultaneous arms,
20/20 sessions 18/18 + one commit):

| median [min–max] | claude | claudindev (batch Read on) | catread (+ cat credit) | placebo |
|---|---|---|---|---|
| cost | $1.039 [0.94–1.10] | **$1.038** [0.95–1.14] | $1.105 [1.04–1.19] | $1.054 |
| API calls | 17 | **17** | 19 | 17 |
| turns before the 1st edit | 4 | 4 | 4 | 3 |
| Read calls (batches) | 0 | 3 (2, 7 files each) | 4 (3) | 3 (2) |
| cache read | 743k | 737k | 889k (+20%) | 789k |
| tool-result chars | 44.4k | 46.7k | 50.4k | 46.6k |

- **Claudin with the batch Read ties Claude Code** on cost and API calls in the
  same run — first time on this bench. Run to run it still swings: in
  `-212723` the readmulti arm was +20% against claude. Quote the tie only with
  its run.
- **catread on top of it is noise or worse**: +6% cost, +2 API calls, +20%
  cache read. The grammar misses fell (refused cats 2 → 1), but with the batch
  Read the model rarely reads by `cat` at all (1 count-as-read line per run).
  It stays behind its two flags, off; the batch Read covers this case.
