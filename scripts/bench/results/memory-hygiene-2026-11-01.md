# memory hygiene — 2026-11-01, branch feat/memory-hygiene

Three benches, Opus 5.5 medium, N=3, each through `bin/claudin` built from the branch.

| Arm | What it is |
|---|---|
| `base` | the branch with `CLAUDIN_MEMORY_HYGIENE=0`: the old dream gate and prompt, no write-time notes |
| `placebo` | `base` plus `CLAUDIN_BENCH_PLACEBO=1`, which nothing reads |
| `claudindev` | the branch as it ships |

The gates were written into the plan (`greedy-petting-torvalds.md`) and each script's
header before the hygiene arm ran. A baseline (base and placebo only) ran first to see
whether the new cases had headroom.

## memory-hygiene-eval.ts — one dream over a seeded mess

The fixture is the mess the October census found, in small: a private copy of a global
memory with one fact more (E1), two team notes saying one thing (E2), an expired bench
snapshot supporting a decision (E3), a team index over 25 KB through 50 component notes
with long hooks (E4), a memory the fixture code contradicts (E5), two memories that
disagree with nothing to settle it (S3), and five controls (S1).

### First run, `/tmp/memory-hygiene-eval/20261101-003547` — every gate passed, and the dream over-deleted

| check | base | placebo | claudindev |
|---|---|---|---|
| S1 controls intact (hard) | 3/3 | 3/3 | 3/3 |
| S2 global never shrinks (hard) | 3/3 | 3/3 | 3/3 |
| S3 contradiction marked | 0/3 | 0/3 | 3/3 |
| E1 private copy merged into global | 0/3 | 0/3 | 3/3 |
| E2 near-duplicates merged | 0/3 | 0/3 | 3/3 |
| E3 snapshot folded and deleted | 0/3 | 0/3 | 3/3 |
| E4 team index under its cap | 3/3 | 3/3 | 3/3 |
| E5 contradicted memory fixed | 2/3 | 3/3 | 3/3 |
| files deleted, total | 0 | 0 | **159** |
| dream $, median | $0.533 | $0.530 | $0.774 |

Every dream of the hygiene arm deleted 53 files: the 3 it should have, and all 50
component notes. The notes were thin, but nobody had retired them. The digest told the
dream, for an index over its cap, to "retire what nothing needs any more". That is the
deletion-to-make-room ("index budget") the plan had ruled out. No gate saw it, because
the notes were not controls.

Fix, `73ce0640`: the digest and the prompt shorten hooks only, and a team memory is
deleted only when it is merged, superseded, wrong or a folded snapshot. The eval gained
**S4 (hard): nothing deleted outside the planted candidates**. It was added after this run
and is reported as such.

### Second run, `/tmp/memory-hygiene-eval/20261101-004853` — after the fix

| check | base | claudindev |
|---|---|---|
| S1 (hard) | 3/3 | 3/3 |
| S2 (hard) | 3/3 | 3/3 |
| S4 (hard) | 3/3 | 3/3 |
| S3 | 0/3 | 3/3 |
| E1 | 0/3 | 3/3 |
| E2 | 1/3 | 3/3 |
| E3 | 0/3 | 3/3 |
| E4 | 3/3 | 3/3 |
| E5 | 2/3 | 3/3 |
| files deleted, total | 0 | 9 (3 a dream, exactly the planted set) |
| dream $, median | $0.524 | $0.490 |

Every gate passed. The placebo was not re-run, because the fix touches only text the
hygiene arm reads. In the first run the placebo sat within one of base on every check.

## memory-write-ab.ts — how memories are written

New cases, `/tmp/memory-write-ab/20261101-003547`:

| request | base | placebo | claudindev |
|---|---|---|---|
| duplicate | 3/3 | 3/3 | 3/3 |
| duplicate-overcap | 3/3 | 3/3 | 3/3 |
| snapshot (`expires:` 30–90 days out) | 0/3 | 0/3 | **3/3** |
| cost, mean/session | $0.105 | $0.107 | $0.112 (+6.7%, gate ≤ +10%) |

- `duplicate` and `duplicate-overcap` had no headroom: base was already 3/3 in the
  baseline. This is read as no regression.
- The near-duplicate note reached the stream in all 3 `duplicate` sessions of the
  hygiene arm.

The seven existing requests, `/tmp/memory-write-ab/20261101-003830`:

| | base | placebo | claudindev |
|---|---|---|---|
| pass | 21/21 | 21/21 | 21/21 |
| cost, mean/session | $0.131 | $0.129 | $0.131 |
| guard refusals | 3 | 3 | 3 |

## memory-recall-eval.ts — how memories are read

New cases (`conflict`, `corrected`, `abstain`), `/tmp/memory-recall-eval/20261101-003548`:
9/9 in every arm, so there was no headroom, read as no regression. The cost medians were
$0.078 base, $0.079 placebo and $0.075 hygiene.

The eight existing cases, `/tmp/memory-recall-eval/20261101-003908`:

| | base | placebo | claudindev |
|---|---|---|---|
| pass | 23/24 | 24/24 | 24/24 |
| cost, median | $0.079 | $0.081 | $0.080 |

- **G1 and G4 print NO.** They are improvement gates from the round that introduced those
  features, and they ask for base ≤ 1/5. Here the base arm already has those features, so
  3/3 against 3/3 is no regression.
- **base team-injection r1** failed. Its placebo was 3/3, inside the noise band.
- **"memory attached by `paths:`" was 1/3 for claudindev.** This is a watched observation,
  not a graded one. In two of its sessions the model batch-read the memory file together
  with `src/math.ts`, so the memory reached context by Read instead of by attachment. It
  reached context in 3/3.

## Spend

The baselines, the arms, the rerun and the live checks came to about $37 in all, on the
Max plan. The plan estimate was ~$45.
