---
name: delegation-steer-ab-2026-09-23
description: Delegation A/B (scripts/bench/ab/delegation-steer-ab.ts) — questions that never mention agents, so a change to the delegation TEXT can be gated; lean Agent text vs full at N=5 held every gate; merge/pricing/env traps in the shared bench modules
type: project
---

`scripts/bench/ab/delegation-steer-ab.ts` (built 2026-09-23 on
`perf/session-cache-round-2`): 7 questions about this repo, answered in a
throwaway clone at a pinned SHA (cached under `/tmp/delegation-steer-ab/`,
fresh `cp -a` per session, never the live checkout). 5 are multi-hop (trace a
flag to its effect, follow a name through three slices, find what gates a
feature), 2 are directed lookups as controls. No prompt mentions agents, so
the model decides — which is what a text change moves. The fork/fresh benches
([[fork-vs-fresh-ab-2026-09-09]]) name the agent to launch, so they cannot gate
steering text. Answers are graded by required substrings; `--dry-run` re-derives
every key and proves each grader (reference passes, one missing item fails).
Opus 5.5 effort high costs ~$3.8 per arm per rep (~$7.4/rep for two arms).

**Result 2026-09-23, N=5, full vs lean Agent text (`CLAUDIN_LEAN_AGENT_PROMPT`)**
— every pre-registered gate held, and the lean text became the default:

| per rep, median | full | lean |
|---|---|---|
| multi-hop delegated (of 5) | 2 | 2 |
| forks | 0 | 0 |
| agent chosen | Code, readOnly, 7× | Code, readOnly, 6× |
| correct answers (all reps) | 35/35 | 34/35 |
| cost incl. sub-agents | $3.905 | $3.626 (−7%, overlap) |

The one miss named the flag but not the function the key requires. What the
workload shows about steering: the model delegates only 2 of the 5 multi-hop
questions (`m3-hook` 4/5 vs 3/5 of reps, `m5-keybind` 3/5 each), never forks,
never delegates a control and never picks a WebResearcher for code; the rest it
answers inline with Grep/Read. Runs: rep 1 `-172734`, reps 2–5 `-173421`.

**Traps, not fixed:**
- `--replay=a.json,b.json` merges by rep NUMBER: two runs that each start at
  r1 collapse into one rep of 14 sessions (medians silently wrong). Renumber
  the second file's reps before merging. The replay also rewrites
  `report.md` inside the FIRST file's `meta.runDir`.
- In the shared modules (reported by the bench's author, the bench itself works
  around both): `forkBench.priceFor` matches `/opus-5/` first and prices
  Opus 5.5 as Opus 5 (5/25, read 0.5 instead of 4/20, 0.2), overstating every
  bench that uses it; `runHeadless` hands the child the host's whole env
  (`CLAUDE_CODE_ENTRYPOINT`, `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS` leaked in a
  test); `transcriptPath`/`loadSession` sanitize only `/` in the cwd while
  claudin replaces every non-alphanumeric, so a workspace path with `.` or `_`
  finds no transcript.
