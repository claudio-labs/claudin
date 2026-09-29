---
name: read-files-ab-2026-09-29
description: read-files-ab (N=5, Sonnet 5.5 @ high, 2026-09-29) — counting a Bash cat as a Read (CLAUDIN_BASH_READ_CREDIT + PASSTHROUGH) failed its pre-registered gate: +13% cost, +14% calls vs claudindev, placebo +17%/+29%, credit engaged 0 files median; the refusals it targets were Grep-seen, not Bash-seen
type: project
---

`scripts/bench/ab/read-files-ab.ts` (engine shared with build-project-ab in
`goProjectBench.ts`): the 13-file Go project, 6 questions whose answers sit in
6 files (ANSWERS.md, graded by regex against a key), then 3 one-line edits and
`go test`. Arms claudindev / catread (both flags) / placebo
(`CLAUDIN_BENCH_PLACEBO=1`, read by nothing) / claude. `--dry-run` has 6 gates.

**Run `/tmp/read-files-ab/20260929-180544`, build 3ae72bd8, all 20 sessions 6/6
answers + 3/3 edits** (median):

| | claudindev | catread | placebo | claude |
|---|---|---|---|---|
| est. cost | $0.117 | $0.132 (+13%) | $0.137 (+17%) | $0.120 |
| API calls | 7 | 8 | 9 | 6 |
| Read / Bash-print calls | 1 / 1 | 1 / 1 | 2 / 1 | 0 / 3 |
| files credited | 0 | 0 [0–1] | 0 | — |
| read-gate refusals | 1 | 1 | 1 | 0 |

All rows overlap. **Gate (promote only if catread beats claudindev on cost AND
calls, SEPARATED from placebo): failed. The credit stays off.**

Why it cannot win here: with the batch Read the model reads by Read, not `cat`
(the credit counted 0 files in 4 of 5 runs). The one refusal per session that
all claudin arms paid (8 of 10) was a Patch on `report_test.go`, a file the
model had only seen in a Grep `content` result while looking for the heading
to rename — the credit does not cover Grep. The fix that would remove it is
the Patch read gate applying a never-read file whose hunks match exactly
(plan of 2026-09-29, [[apply-patch-failure-taxonomy]]).
