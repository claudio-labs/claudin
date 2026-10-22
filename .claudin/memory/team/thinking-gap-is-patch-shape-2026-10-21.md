---
name: thinking-gap-is-patch-shape-2026-10-21
description: Claudin's ~2x thinking vs Claude Code is Opus-only and follows the Patch edit shape — no gap on Sonnet 5.5; forcing Patch on Sonnet reproduces it; a read×write 2×2 puts it on the write side; on Opus it is planning up to a 5–7-file first edit; CLAUDIN_BASH_FIRST (+ sed -n read credit) passed the Sonnet non-regression stage 10-22, Opus stage pending
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

**How to apply:** to cut thinking or latency, change the edit shape (bash-first text, smaller
patches), not the prompt prose or the wire. Benchmark thinking questions on Opus, or force Patch on
Sonnet; plain Sonnet measures nothing here.
