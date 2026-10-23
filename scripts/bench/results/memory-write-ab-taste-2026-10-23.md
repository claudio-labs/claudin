# memory-write-ab — 2026-10-23, branch feat/memory-ai-memory-round-2

`scripts/bench/ab/memory-write-ab.ts --reps=3`, `claude-opus-5-5` at `medium`, one build of d00efcdd.
Run: `/tmp/memory-write-ab/20261023-231307`.

| Arm | What it is |
|---|---|
| `claudindev` | the branch build with no extra variable: today's memory wording |
| `placebo` | the same binary with `CLAUDIN_BENCH_PLACEBO=1`, which nothing reads |
| `taste` | `CLAUDIN_BENCH_USER_TASTE=1`: taste filed as `user`, feedback scoped by subject, a mixed correction split at write time |

## Pass rates

| Request | Measures | claudindev | placebo | taste |
|---|---|---|---|---|
| pnpm | control: a project fact, never global | 3/3 | 3/3 | 3/3 |
| staging | control | 3/3 | 3/3 | 3/3 |
| correction | control: "aqui a gente…", never global | 3/3 | 3/3 | 3/3 |
| decision | control | 3/3 | 3/3 | 3/3 |
| preference | control: a stated preference, global | 3/3 | 3/3 | 3/3 |
| taste | "eu detesto default exports" — global | 3/3 | 3/3 | 3/3 |
| taste-split | taste global, project part (`FixedClock`) private or team, neither copying the other | 3/3 | 3/3 | 3/3 |
| **all** | | **21/21** | **21/21** | **21/21** |
| cost, mean/session | | $0.127 | $0.128 | $0.129 |
| API calls, mean | | 4.1 | 4.0 | 4.2 |

## Mechanism

The arm changed nothing the grader or the files show. Every `taste` and `taste-split` session in every
arm wrote the taste as a global `type: feedback` memory — none as `type: user`, the wording's whole
lever — and every split's project part landed in `team/` (`type: project` or `feedback`).

## Reading

No headroom: the main agent already files an explicit taste correction globally and splits a mixed
one, without the new wording. **Not promoted** (decided 2026-10-23): the switch and its wording were
reverted in the same PR; the `taste` and `taste-split` requests stay, as controls for the next
memory-prompt change.

What the bench does not reach is where the misfiled memories in this repo came from: most private
`feedback-*` memories predate the global dir (2026-10-09), and the later ones were written in long
sessions or by the extraction fork, neither of which a two-turn `-p` session drives.
