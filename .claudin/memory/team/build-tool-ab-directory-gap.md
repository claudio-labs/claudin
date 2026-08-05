---
name: build-tool-ab-directory-gap
description: Build tool A/B 2026-08-04 — cost −7.7% median of 3, but ONLY after adding `directory`; without it the tool cost +27% and was ignored
type: project
---

`scripts/profile/build-tool-ab.ts` — two arms on one build (`CLAUDIN_DISABLE_BUILD_TOOL=1`
vs on), Sonnet 5, 15 steps over a five-language workspace in `/tmp` (bun, go,
cargo, make+cc, make+javac), one planted compile error per project.

**The first run was a negative result, and it found a real defect.** Cost **+27.2%**,
input +30.9%, cache_read +41.8%. Cause: `Build` could only ever build `getCwd()`,
so in a workspace where every project is a subdirectory the model called it 4
times (2 of those on the root, which detects nothing), gave up, and ran **18 of
22 builds** as `cd pkg && …` in Bash. The redirect never fired on those either —
`hasShellComposition` drops any `&&`. The tool was priced with none of its
benefit.

Fixes that followed (2026-08-04): a `directory` input on the tool, the redirect
learning a single `cd <dir> && <build>` prefix, and the "nothing detected" error
naming the subdirectories that do have a build (`detectSubprojects`).

**After the fix, median of 3 clean reps** (all sentinel=Y, model verified):

| | before | after | delta |
|---|---|---|---|
| cost usd | 0.8922 | 0.8238 | **−7.7%** |
| output tokens | 7.1k | 5.3k | −25.1% |
| input tokens | 122.8k | 112.0k | −8.8% |
| cache_creation | 17.6k | 15.2k | −13.2% |
| cache_read | 1.06m | 1.08m | +2.0% (noise) |
| end context | 38.6k | 38.2k | −1.0% |
| build payload chars | 3.1k | 2.3k | −25.3% |
| Bash builds | 17 | 0 | −100% |
| Build calls | 0 | 22 | — |

**Why:** the headline is adoption, not bytes. Cite −7.7% cost and −25% output,
not the cache_read column.

**Do NOT cite "tool calls" for this tool — it inverts the result.** Calls go UP
(36 → 41/run) while the work goes DOWN: the arm without the tool packs ~4.3
commands into each Bash call, so counted as shell segments it is 106.3/run vs
**49.0** (−54%). Per-command totals over 3 reps: `echo` 81 → 8, `cd` 57 → 5,
`cat` 18 → 5, build runners 77 → 1. Without the tool the model writes the build
as a pipeline (`cd api && ls -la && cat main.go && go build ./... ; echo "exit:$?"`)
because a Bash result is an unstructured blob — the separators and `$?` capture
exist only to parse it back. That scaffolding is most of the −25% output.

**How to apply:** any new detect-and-run tool must take the directory it runs in
— `getCwd()`-only makes it dead weight in a monorepo, which is most repos. And
run the A/B before believing a tool helps: `liveCoverage.test.ts` showed −90% on
payload for the same builds the live session made 27% *more* expensive.

Related: [[git-tool-design]] (same harness, same protocol), [[typecheck-ab-bench-fixture-flaw]].
