---
name: bash-filter-shape-wontfix
description: Bash filter — shape blindness (pipes/chains) is CLOSED as wontfix with numbers; the only bucket a new spec can reach is 6.8% of chars, and the 2026-08-29 prefix round moved this corpus by +4 calls
type: project
---

The Bash output filter's coverage ceiling is a **shape** problem, not a missing-spec
problem, and both halves now have numbers. Do not re-open either without new data.

**Measured 2026-08-29**, fresh 60-day corpus (`extract-bash-corpus.ts --days 60`,
18,310 calls / 20.4M chars), replayed with `measure-bash-filter-replay.test.ts`:

| first blocking gate | %chars |
|---|---|
| non-reducer pipe | 50.7% |
| chain with disagreeing heads | 10.2% |
| **atomic, no filter registered** | **6.8%** |
| subshell or control flow | 4.2% |
| reducer pipe, base has no filter | 2.1% |

Coverage that build: 12.3% of calls, 12.8% of Bash chars (18.4% / 16.6% counting
what production had already filtered before recording).

**Shape = WONTFIX.** `registry.ts:56` returns null when segments disagree and
`pipeline.ts:366` bails on any top-level pipe, both because the router cannot
attribute a line to a segment. The generic floor already covers those bodies: a
separate check over one week of transcripts replayed today's filter across the
291 unfiltered non-error results above 1 KB (651 KB) and found only **29 KB
(4.5%)** left to take. Attacking it properly needs segment-boundary sentinels in
the executed command — rejected on risk for that 4.5%.

**Specs = 6.8% ceiling.** That is the whole `atomic, no filter registered`
bucket, and the round of 2026-08-29 spent it on matching RULES rather than new
specs: execution-prefix arms (`bundle exec`, `rbenv/pyenv/asdf exec`, `rye/pdm/
conda/micromamba run`, `uvx`, `pipx run`, `npm/yarn exec`, `mise exec`, `dotnet
tool run`, `nvm/volta/fnm`, `flock`, `direnv exec`, container `exec`) plus a
generic path strip for `./node_modules/.bin/X`-style binaries. On THIS corpus
that is +4 calls / +333 chars — the arms fire on 183 commands (~1%) and the
ecosystems they unlock (Ruby, PHP, .NET, conda) are simply absent here. Keep the
coverage, do not quote a win from it.

Two real bugs came out of the same sweep, both fixed: `PYTEST_MATCH` accepted
`python -m pytest` but not `python3 -m pytest`, and `yarn-install` matched
`yarn <anything>` — saved only by jest/vitest/tsc being registered earlier. The
second has a durable lesson recorded in `filters/js-pkg.ts`: `matchesAtomicCommand`
tests `matchCommand` against the bare **verb** as well as the whole command, so a
spec that accepts a bare `yarn` accepts every subcommand with it. A negative that
must read the whole command belongs in `matchCommandReject`.

Machinery to reuse: `scripts/bench/tokens/extract-bash-corpus.ts` (writes outside
the repo, it holds verbatim output), `measure-bash-filter-replay.test.ts` (report,
always passes), `measure-bash-error-floor.test.ts` (the failing-command lane,
which transcripts cannot show at all — error output is never marker-wrapped), and
`prefixRouting.test.ts` (the routing matrix, negatives included).
