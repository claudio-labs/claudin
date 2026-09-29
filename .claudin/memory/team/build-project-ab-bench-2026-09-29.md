---
name: build-project-ab-bench-2026-09-29
description: Build-project A/B (claudindev vs Claude Code 2.1.284, Sonnet 5.5 @ high, 13-file Go project, change + `make build`), N=3 on 2026-09-29 — both 7/7 hidden; claudindev 6 calls vs 7, $0.236 vs $0.265 (overlap); first-turn context and thinking SEPARATED lower; Claude Code writes more tests
type: project
---

`scripts/bench/ab/build-project-ab.ts`, fixture `__fixtures__/build-project-ab/`
(`.tpl`): `logstat`, a 13-file Go CLI. One prompt asks for `--format json`, a p99,
a case-insensitive `--method` filter and a fix (latencies written in seconds
were counted as malformed), plus tests, the README and `make build`. Go was
picked because `go build` is a real compile with zero deps; the global `tsc` is
a mise shim that fails outside the repo. The grader builds the workspace
itself, runs vet/gofmt/`go test`, runs 7 hidden checks against its own binary,
and checks whether the model's `bin/logstat` is newer than every non-test .go
file. `--dry-run` has 13 gates (the reference passes, pristine fails all but
the `--format xml` rejection, a solution missing only the parse fix goes RED).
The proxy is on by default (`--no-proxy`) and the grade table shows the model
and effort each arm actually sent. The helpers are exported from
session-cache-ab.ts (`phaseRunOf` was extracted from its `runPhase`).

**Result, run `/tmp/build-project-ab/20260929-143200`, N=3, all 6 sessions 7/7
hidden and built:**

| median | claude | claudindev |
|---|---|---|
| API calls (= HTTP requests; 0 side requests in `-p`) | 7 | 6 (overlap) |
| first-turn context | 19.6k | 18.0k (SEPARATED) |
| end context | 38.9k | 40.0k (overlap) |
| context summed over calls | 216.5k | 178.5k (overlap) |
| cache read / write | 187.0k / 29.0k | 148.0k / 28.9k (overlap) |
| thinking | 1.2k | 944 (SEPARATED) |
| cost | $0.265 | $0.236 (−11%, overlap) |
| go test cases (pristine 6) | 18 | 15 (SEPARATED) |

Both sent `claude-sonnet-5-5` with `effort: high` on every request. Claude Code
was 100% Bash (×20); claudindev used Bash×7, Read×4, Glob×2, Patch×5. All
cache writes were 1h TTL, with no breaks. At 6–9 calls this task is small for
Sonnet 5.5, so N=3 separates little. For more signal, use a bigger prompt or
more reps, not a second model.

**Round 2 (same day, run `-145151`, N=5, after the Add File parse repair —
[[apply-patch-failure-taxonomy]] #5 — and with the refusal / re-send /
cost-by-source rows added to the report):** 10/10 sessions 7/7 hidden and
built. Calls 7 vs 7, cost $0.251 vs $0.234 (−7%, overlap). SEPARATED: first
turn 20.3k vs 18.0k, prefix cost $0.068 vs $0.051, and tool-result chars
16.3k vs 18.4k (+12%, Read's line numbers against `cat`). Test cases 17 vs 15
now overlap. The Add File failure did not recur in 5 runs, so the replay, not
the bench, is that fix's evidence. Two runs re-sent a whole 10–11k-char patch
(up to 6.2k tokens, $0.089) over hunks placed out of file order — the
position-miss finding in the taxonomy memory.

**Round 3 (run `-153851`, N=5, Sonnet 5.5 @ high, after the out-of-order repair
— taxonomy #6):** 10/10 sessions 7/7 and built. The fix fired once (r2 sent
`stats_test.go` hunks 51→20 and it applied first time). Re-sent edit output
went from max 6.2k tok/$0.089 to max 103 tok/$0.001: the one refusal was the
README read gate, answered with `*** Resubmit`. claudindev cost $0.232
[0.210–0.252] vs $0.234 [0.207–0.313] in round 2: the tail is gone, the median
is flat. vs claude $0.250: −7% (overlap). SEPARATED: output −17%, visible
output −16%, prefix −19%, but tool results +36% ($0.050 vs $0.037; Read's
line numbers plus a whole-project Read) and test cases 14 vs 18. Calls 8 vs 7
(overlap), from the model splitting source and tests into two patches, not
from the fix.

**Round 4 (run `-183540`, build with [[patch-applies-what-matches]]):** 10/10
sessions 7/7 and built. claudindev 6 calls [6–7] vs claude 7 [6–9], cost
$0.249 vs $0.247 (+1%, overlap). No Patch was refused for matching or the read
gate. The re-sends left (median 777 tok, $0.011) were all a new class: 3 of 5
sessions put 4+ commands in `then`, which the schema caps at 3, so zod
rejected the whole Patch before the tool saw it (InputValidationError).
