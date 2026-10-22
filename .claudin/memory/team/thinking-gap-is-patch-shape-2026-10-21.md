---
name: thinking-gap-is-patch-shape-2026-10-21
description: Claudin's ~2x thinking vs Claude Code is Opus-only (medium) and follows the Patch edit shape — forcing Patch on Sonnet reproduces it; on Opus it is planning up to a 5–7-file first edit; 10-22 Opus high: fixed CLAUDIN_BASH_FIRST (462a7bd9) edits like CC (0 patches, 1-file first edit), thinking −16% vs placebo (overlap), classifier ×4 in auto; user kept today's flow
type: project
---

Session A/B (`session-cache-ab.ts --proxy`), 2026-10-21, v1.1.46 @ 65720b0e vs Claude Code
2.1.304; every session passed the hidden tests. Refines [[session-cost-round-3-2026-09-23]], which
pinned the gap on "the system prompt as a whole".

| run | claude | claudindev | placebo | forced Patch |
|---|---|---|---|---|
| Sonnet 5.5 medium, N=5 (`-192519`) | 771 | 601 | 710 | – |
| Sonnet 5.5 high, N=4 (`-193933`) | 2.5k | 1.6k | 2.1k | 3.6k (SEPARATED vs claudindev) |
| Sonnet 5.5 high, N=2, summarized (`-195949`) | 2.0k | – | – | 3.1k |
| Opus 5.5 medium, N=5 (`-133607`+`-134048`) | 2.4k | 4.5k (SEPARATED) | 4.1k | – |

- **Sonnet has no gap.** Both CLIs edit through python heredocs there, and claudin thinks less
  and costs 15–20% less. Forced Patch is `--append-system-prompt-file` with "make every file change
  with the Patch tool"; a per-file variant thought 2.9k and cost +42% (34 turns).
- **Opus, per response** (transcripts): a Patch thinks 442 tokens (85% think, 4.5 files, 5.8k
  chars, 0 of 26 failed) against Claude Code's Bash heredoc edit at 154 (52%, 3.8k chars). Non-edit
  turns think 301 vs 152, and the resumed first turn 1.1k vs 0.45k. Total output is equal (22.8k vs
  22.1k) and cost too ($1.022 vs $1.027): the thinking replaces visible text.
- **What the Sonnet Patch thinking says** (summaries): planning is the same size in both CLIs. The
  extra is repair turns: "hunk had a blank line missing its prefix", "anchoring matched the wrong
  position… duplicated lines". Opus has 0 failed patches, so there it is care before the call.
- The bashfirst arm of [[edit-method-census-2026-10-21]] is the Opus counter-test: Bash edits 58%,
  thinking 4.5k → 3.4k, cost −6% (= placebo).
- Wire is not the cause: same adaptive thinking, effort and betas on both models. CC 2.1.304 adds
  `inline-tools-2026-09-15`, budget and "user hasn't heard from you" (`silent_turn_reminder`,
  Sonnet) as role:system messages. Its catalog lists `opus_5_5_prompt_bundle`, but `-p` sends the
  same system prompt to Opus and Sonnet. The only Opus difference is the bash-first paragraph.
- Real traffic can't split by effort: Claude Code records `effort` on assistant entries, Claudin
  does not. The census script was `census/census.ts` in that session's scratchpad.

**Levers, branch `perf/patch-thinking` (opt-in, `steeringToggles.ts`).** The session report now
has a "Thinking by response kind" table and a patch-miss row; replayed, it puts Opus claudindev's
read turns at 2.0k against Claude Code's 0.7k, beside Patch's 2.4k. Sonnet high with forced Patch,
N=4 (`-204511`), every session passed:

| | patch | lean | soft | placebo |
|---|---|---|---|---|
| thinking | 3.9k | 2.7k (−31%) | 3.1k (−19%) | 3.3k (−15%) |
| patch responses / misses | 8 / 3 | 12 / 4 | 11 / 2 | 10 / 2 |
| cost | $0.674 | $0.655 | $0.699 | $0.636 |

- `CLAUDIN_LEAN_PATCH_PROMPT` drops the rules patchFormat.ts rescues. It thinks least, but sends
  more and smaller patches and misses more.
- `CLAUDIN_SOFT_BATCH` drops "Read every file first". It halves Patch-turn thinking (2.6k → 1.2k)
  but makes more patches.
- Neither passed the gate set before the run (−20%, outside the placebo band). That gate was the
  user's condition for taking a lever to Opus.

**Read or write? A 2×2 on Sonnet high (`-211220`, N=4, all passed).** Each arm got one appended
sentence naming how to read and how to write, with no placebo (the user's call).

| | claude | cat + Bash | Read + Bash | cat + Patch | Read + Patch |
|---|---|---|---|---|---|
| thinking | 2.6k | 1.6k | 3.8k | 4.4k | 3.8k |
| cost | $0.562 | $0.440 | $0.537 | $0.683 | $0.647 |
| files in each phase's first edit | 1 / 1 | 1 / 1 | 1 / 1 | 9 / 8 | 8 / 8 |

- **The write side replicates.** Five forced-Patch runs on Sonnet high thought 3.1–4.4k. Bash-edit
  arms in the same runs thought 1.6–2.1k.
- **The read side did not replicate.** A rerun with summaries (`-212717`, N=2) put Read + Bash at
  1.9k against cat + Bash at 2.0k. The summaries never mention line numbers.
- Opus, by `planningThinking` (new bench rows): thinking up to the first edit is 1.4k / 1.3k against
  Claude Code's 0.7k / 0.56k, and that first edit is 5–7 files against Claude Code's 1.
- cat + Bash on Sonnet thinks less than Claude Code itself and costs 22% less (SEPARATED).

**Two solutions, opt-in on the branch (10-22).** `CLAUDIN_BASH_FIRST=1` (`35ab977b`) changes three
places together: the `# Harness` preference bullet, the compact Bash description's
read/edit/write forms, and the file-reads advice note. Search and the dev tools keep their
pointers. Under `CLAUDIN_BASH_READ_CREDIT=1` a `sed -n A,Bp f` slice now counts as a ranged
Read (`015bb16f`). It survives `/resume`, and it drops the ranged-Read advice it made moot.
`CLAUDIN_SOFT_BATCH` is the native alternative that keeps Patch.

Sonnet stage, high, N=4, bypass (`20261022-030944`, 16/16 passed, no placebo by the user's call).
The gate was non-regression against claudindev, set before the run:

| | claude | claudindev | bashfirst | soft |
|---|---|---|---|---|
| thinking | 2.5k | 1.9k | 1.7k (−31% vs CC, SEPARATED) | 1.9k |
| cost | $0.516 | $0.531 | $0.430 (−17% vs CC, SEPARATED) | $0.461 |
| thinking up to the first edit, P1 / P2 | 969 / 948 | 678 / 399 | 588 / 435 | 377 / 553 |

- Both arms passed every gate. The mechanism engaged: bashfirst got 0 file-read notes against
  claudindev's 4, and sed-credit lines appeared.
- Sonnet cannot show the gain: claudindev already edits through Bash there (0 Patch calls in
  every arm). The efficacy gates are for Opus, in auto mode with the classifier priced: thinking
  ≤ −20%, thinking up to the first edit ≤ 1.3× Claude Code's, and cost ≤ claudindev's max.
- The `/tmp` run dirs of 10-21 were lost to a reboot. The numbers above are what survives.

**Opus stage, high, auto mode, N=4 (`20261022-032941`, 16/16 passed, no placebo).** Neither arm
passed the efficacy gates.

| | claude | claudindev | bashfirst | soft |
|---|---|---|---|---|
| thinking | 5.2k | 6.5k | 6.5k (0%) | 5.4k (−17%) |
| cost + classifier | $1.260 + 0 | $1.196 + $0.147 | $1.161 + $0.155 | $1.111 + $0.103 |
| Patch responses / first-edit files P1, P2 | 0 / 1, 1 | 5 / 6, 8 | 5 / 6, 8 | 7 / 5, 6 |
| thinking up to the first edit, P1 / P2 | 1.8k / 1.9k | 3.0k / 2.6k | 1.9k / 2.5k | 2.1k / 1.6k |

- At high effort the gap is +25% and overlaps; it is not the 2× seen at medium.
- **bashfirst's text reached the wire but did not change the edit.** It had 0 read notes and 34
  credit lines, yet the same Patch count and first-edit size. The likely cause: the Anthropic
  batched-edits addendum ("land it as ONE Patch…") still stands under `CLAUDIN_BASH_FIRST`.
- **soft came closest.** Its thinking sits about level with Claude Code's, and it was the
  cheapest and fastest arm. −17% misses the −20% gate, and with no placebo it is inside noise.
- The run took 29% of a Max 5x 5-hour window (19→48%) and 2% of the 7-day one.

**Fixed bash-first, Opus high, auto, N=4 (`20261022-035706`, `462a7bd9`, 12/12 passed).** Under the
flag the batched-Patch clause and the Typical-flow line now stand down, and the bullet carries the
meaning of Claude Code's default strict steer. The first wording followed its relaxed one.

| | claudindev | bashfirst | placebo |
|---|---|---|---|
| thinking | 8.6k | 4.9k (−43% SEPARATED; −16% vs placebo, overlap) | 5.8k |
| cost + classifier | $1.229 + $0.151 | $1.175 + $0.182 | $1.139 + $0.109 |
| Patch responses / first-edit files P1, P2 | 4 / 6, 8 | 0 / 1, 1 | 7 / 6, 8 |
| thinking up to the first edit, P1 / P2 | 3.2k / 2.9k | 1.9k / 1.5k | 2.7k / 1.8k |
| classifier requests / turns | 3 / 14 | 12 / 23 | 2 / 18 |

- **The mechanism now engages.** There were 0 patches, and the first edit is 1 file in both
  phases, as in Claude Code. Planning thinking sits at Claude Code's level (1.8k / 1.9k in
  `-032941`).
- **The thinking win is real but small against the no-op arm.** It is −16% against placebo. The
  claudindev arm ran high (placebo was −33% against it), which shows how noisy Opus high is at N=4.
- **In auto mode the cost is neutral to slightly worse.** Every Bash edit goes through the
  classifier, while Patch and Edit take the fast path: 12 classifier requests against 3, and
  classifier cost +20% SEPARATED. Bypass would not pay that.
- The run took 19% of the 5-hour window (50→69%).
- **Why bashfirst makes more turns** (transcripts, means per session). It makes 21.8 responses,
  against 18.5 for placebo and 18.5 for Claude Code.
  - Its edit responses match Claude Code's: 10.0 against 10.3. Each is a small Bash edit with the
    tests chained on, where Patch lands a phase in ~2 calls. That is the incremental shape that
    cut the planning thinking.
  - The rest is phase 2. Mid-phase `sed -n` reads and manual CLI runs come to about +2.5 against
    Claude Code. claudindev runs the CLI by hand in phase 2 too, so that part is a Claudin trait,
    not bash-first.
  - The `+64%` row in the report compares against claudindev's median of 14, which ran low.

**Decision 2026-10-22:** the user kept today's batched-Patch flow as the more economical one. Every
lever stays opt-in. Lean, soft and the `sed -n` credit ship off by default, and bash-first stays
on the local branch `perf/patch-thinking` ([[patch-thinking-levers-not-promoted]]).

**How to apply:** to cut thinking or latency, change the edit shape (bash-first text, smaller
patches), not the prompt prose or the wire. Benchmark thinking questions on Opus, or force Patch on
Sonnet; plain Sonnet measures nothing here. In auto mode, price the classifier: a Bash edit pays
for it and a Patch does not.
