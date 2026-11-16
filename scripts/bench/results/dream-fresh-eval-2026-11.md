# Dream without the parent conversation, eval — 2026-11-16, branch fix/census-2026-11-16

`CLAUDIN_AUTO_DREAM_FRESH=1` forks the dream with the parent's system prompt, tools and model
and none of its messages (`src/memory/autoDream/autoDream.ts`). The 11-14..16 census found a
dream reading 487k tokens on each of 24 calls, almost all of it the parent's conversation, which
the consolidation prompt never refers to. This run asks whether the dream still cleans as well
without it.

```
bun scripts/bench/ab/memory-hygiene-eval.ts --reps=N \
  --variant=base:CLAUDIN_AUTO_DREAM_FRESH=0 \
  --variant=placebo:CLAUDIN_AUTO_DREAM_FRESH=0,CLAUDIN_BENCH_PLACEBO=1 \
  --variant=fresh:CLAUDIN_AUTO_DREAM_FRESH=1 \
  --only=base,placebo,fresh --new=fresh
```

Opus 5.5, effort medium, build 6bf48168. Three reps, run as one rep and then two
(`20261116-212551`, `20261116-212852`), with `/usage` read between them. Every arm has memory
hygiene on, so `base` and `placebo` delete files too: the script's own M and C gates are written
for a hygiene-off base and do not apply. The gates below were written in the plan before the run.

## Result

| Arm | Rep | Checks | Deleted | Dream $ | Calls | Cache read / call | Cache write / call | Output tokens |
|---|---|---|---|---|---|---|---|---|
| base | 1 | 9/9 | 3 | 0.453 | 9 | 38.5k | 3.2k | 7,576 |
| base | 2 | 9/9 | 3 | 0.452 | 14 | 37.7k | 1.6k | 8,250 |
| base | 3 | 9/9 | 3 | 0.428 | 10 | 37.2k | 2.8k | 6,530 |
| placebo | 1 | 9/9 | 3 | 0.458 | 11 | 37.6k | 2.6k | 7,142 |
| placebo | 2 | 9/9 | 3 | 0.462 | 13 | 37.9k | 2.1k | 7,230 |
| placebo | 3 | 9/9 | 3 | 0.409 | 11 | 37.2k | 2.0k | 7,327 |
| fresh | 1 | 9/9 | 3 | 0.741 | 11 | 32.2k | 4.1k | 15,566 |
| fresh | 2 | 9/9 | 3 | 0.747 | 14 | 33.6k | 2.9k | 16,646 |
| fresh | 3 | 9/9 | 3 | 0.639 | 15 | 35.7k | 2.8k | 9,719 |

Checks are S1 S2 S4 S3 E1 E2 E3 E4 E5. The usage columns are the `auto_dream` entry of each
session's last `cost-state.sourceUsage`.

## Gates

| # | Gate | Verdict |
|---|---|---|
| 1 | S1, S2 and S4 pass in every `fresh` rep | PASS — 3 of 3 |
| 2 | `fresh` is not below `base` on S3 and E1–E5 by more than `placebo` is | PASS — every arm 9/9 in every rep |
| 3 | mechanism: the dream reads less from cache per call in `fresh` than in `base`, in every rep | PASS — 32.2k < 38.5k, 33.6k < 37.7k, 35.7k < 37.2k |
| 4 | cost: reported, not gated | median $0.741 against $0.452 (× 1.64); placebo $0.458 |

## Reading it

- The dream cleans the same without the conversation: nothing in the nine checks moved.
- It costs more here, and the cause is output, not cache: `fresh` wrote 9.7–16.6k output tokens
  against 6.5–8.3k in `base` and 7.1–7.3k in `placebo`. The bench parent is a single `ok`, so
  there is almost no conversation to save (2–6k tokens a call), and what the fork loses with it
  is the first message of the session. That message carries the instruction and memory-index
  attachments; the likely reason for the extra output is the dream reading them back from disk.
  That reason is inferred from the token counts. The dream keeps no transcript, so it was not
  observed.
- Break-even, from these numbers: `fresh` cost $0.21–0.30 more per dream. At $0.20 per million
  tokens read, a 14-call dream earns $0.25 back once the parent's conversation is past ~90k
  tokens. The census dream at 487k would save about $2 of $3.49; a dream after a short session
  loses.

## Decision

The switch stays off. Quality held, but the default would raise the cost of every dream that
fires after a short session. The candidate that follows from the table is to keep the head of
the conversation (the first message, which the parent has already cached) and drop the rest;
it is not built and would need this eval again.
