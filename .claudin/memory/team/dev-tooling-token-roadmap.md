---
name: dev-tooling-token-roadmap
description: Ranked roadmap for the next dev-loop token savings (Grep budget, git diff wrapper, Read re-read dedup, redirect coverage, build wrapper), backed by a 2026-08-04 transcript measurement
type: project
---

Roadmap decided 2026-08-04, after RunTests and Typecheck shipped. Ranks what to
wrap NEXT in the detect/parse/budget/redirect family, using measured spend rather
than intuition.

**Why:** the first two wrapper tools were built where the idea was obvious, not
where the tokens were. The measurement says they landed on a small target, so the
next picks should follow the numbers.

**How to apply:** when picking the next token-efficiency work, start at D1. Cite
the measurement below rather than re-deriving it; re-measure with the same method
before claiming a win.

## Measurement (2026-08-04, method reusable)
34 session transcripts in `~/.claudin/projects/-home-viudes-projects-claudin/*.jsonl`
covering 2026-07-28 → 2026-08-04: 2,152 main-thread tool calls, 2,746,075 chars of
`tool_result` (~686k tokens). Aggregate with `jq`/`python3` over the JSONL — never
Read those files. Sub-agent sidechains live in separate files and are NOT in these
totals.

| tool | calls | ~ktok | share |
|---|---|---|---|
| Read | 429 | 340 | 49.5% |
| Bash | 846 | 161 | 23.5% |
| Grep | 232 | 126 | 18.3% |
| Typecheck + RunTests | 132 | 22 | 3.2% |

Read+Bash+Grep = 91% of all tool-result chars. Inside Bash: `git` 25%, `bun` 14%.
`head` appears 399× and `tail` 265× across Bash calls — the agent hand-rolls output
capping on most calls, which is the tell for missing coverage.

## Ranked (D1 → D5)

### D1 — Grep budget (~126k tok surface, effort S) — DONE 2026-08-04
212 of 232 Grep calls run `output_mode:"content"` (mean 2,336 chars) vs 20 in
`files_with_matches` (mean 355); the largest calls pass no `path`/`glob`.

Landed on `feat/grep-context-summarizer` — but summarizer-side, not as the
`src/tools/GrepTool/budget.ts` this item proposed. The existing `grep-grouped`
strategy already had the per-file cap and dedupe; what it lacked was parsing rg's
`path-NN-text` context lines at all, so a context-heavy result fell into the
literal bucket and the no-win guard shipped it whole. Fixing that plus the header
accounting took the take from **10.0% to 15.5%** of all Grep chars (20.5% → 33.5%
of the context-bearing ones) over 5,096 recorded results. Also fixed there: rg
context lines leaked absolute paths, worth 4.5% on its own.

The second half — the auto-pivot to the symbol map — landed the same day as
`GREP_AUTO_PIVOT` (`src/tools/GrepTool/autoPivot.ts`, flag ON): a content search
over ≥5 files with ≥6k chars or ≥60 match lines, and no explicit
`head_limit`/`offset`, returns `buildSymbolsOutput` instead of the lines, but
only when the map is ≤70% of what it replaces. Measured by the new `--pivot`
mode of `scripts/profile/grep-summarizer-replay.ts` over the whole recorded
corpus: 64 pivots, **6.6% of all content-mode Grep chars saved outright and 3.7%
on top of what the summarizer already saves losslessly** — that second number is
the one that justifies a lossy mode change, and the one to re-derive before
touching the thresholds. `files ≥ 3` would have reached 8.6%/4.3%; five is a
deliberate safety margin. The `head_limit` suppression is expensive (it holds
46.8% of the chars out of scope) and still correct: those values cluster at
10-60, i.e. real sizing.

Two traps this work exposed, both live outside the Grep code:
- **`buildTool` wraps Grep in the 30s tool-result cache keyed on input alone**
  (`isCacheableTool`/`wrapCallWithCache`), so repeating an identical search
  replays the earlier decision — three tests silently asserted against a cached
  result until the suite set `CLAUDIN_DISABLE_TOOL_RESULT_CACHE=1`. The same
  applies to the killswitch at runtime: flipping it does not re-answer a search
  the cache already served.
- **Importing anything from `GrepTool.ts` in a script hits the GrepTool ↔
  GlobTool/UI cycle** ("Cannot access 'GrepTool' before initialization"). That
  is why `buildSymbolsOutput` now lives in its own `symbolsOutput.ts`.

### D2 — Git tool — DONE 2026-08-04 (branch `feat/git-tool`)
Landed much wider than "a `git diff` wrapper": one `Git({commands: [...]})` tool
covering **all** of git and gh, reads and mutations, with the list as the input
so a burst is one call.

**Re-measured first, over 760 sessions** (`scripts/profile/git-tool-baseline.ts`,
which is the reusable measurement) — the 34-session numbers this roadmap was
written from were off: git+gh is **22.6% of Bash chars, 5.0% of ALL tool-result
chars** (1.70M of 33.98M). `git diff` 162 calls/428k chars, `git status`
268/234k, **`gh run` 117/202k** (unplanned #3, CI log dumps), `git log`
137/153k, `git add` 274 calls but only 422 mean. **Only 199 of 760 sessions
(26%) ran any git command** — the number that decides whether an always-present
tool pays for its description.

Numbers to cite:
- **Replay** (`git-summarizer-replay.ts` over the recorded corpus): **30.6%
  take** on the 230 addressable calls; 27.4% projected with output-trim tails
  stripped. `git diff` 37%, `gh run` 42%, `gh pr` 34%. `git log` got **no
  summarizer** — the Bash filter's `--oneline` rewrite already took it, and the
  replay proved there was nothing left.
- **Live A/B** (1 run/arm, 15 turns, Sonnet 5, one build with
  `CLAUDIN_DISABLE_GIT_TOOL=1` as the "before" arm): cost **−11.5%**,
  cache_creation **−24.6%**, cache_read −10.6%, input −7.4%.

**The batching claim did NOT survive.** Bash already batches with `&&` at 1.50
git commands per call vs the tool's 1.46, and calls-per-burst rose 4.00 → 4.33
because the one-shot redirect refusal costs an extra call. Cite payload and
cache, never call count.

Design notes worth keeping: permissions delegate to `bashToolHasPermission`
verbatim (so `Bash(git push:*)` rules still apply and the ~900-line security
pipeline is not reimplemented); `isReadOnly` is per-command and fails closed,
which is what lets `git diff` run inside plan mode; the diff pivot is at 6 KB
because file-count pivots are useless (43 of 83 recorded diffs are single-file).

### D3 — Read re-read dedup (effort M, delicate) — NOW THE BIGGEST ITEM BY FAR
196 of 429 Read calls (639,163 chars) re-read a path already read in the same
session. Existing clip-pin / dedup stand-down only covers entries a prior FULL
Read wrote; the gap is "file unchanged since your last read" → return the delta,
not the body. Touches the clip-frontier cache invariant, so plan it separately.

The 760-session re-measurement makes the ranking stark: **Read is 58.4% of all
tool-result chars (19.8M) against git+gh's 5.0%** — an order of magnitude more
than D2 was. `src/tools/GitTool/delta.ts` is now a working precedent for the
elide-what-you-already-sent lane, including the rule that matters: fire only
when the previous body's `tool_use_id` is absent from `getClippedIds()`, so
nothing invisible is ever elided.

**Re-sized 2026-08-07** (504 transcripts, 258 sessions with main-thread calls,
2026-07-06 → 2026-08-07, 17,124 calls / 21.59M tool_result chars; method as
above). Read **59.7%** (4,196 calls, 12.90M chars), Bash 19.7%, Grep 11.0%,
Agent 2.9%, ExitPlanMode 2.5%.

The honest ceiling is much smaller than "45.9% of Read is re-reads" suggests:
- re-reads of an already-read path: 2,004 calls / 5.92M chars (27.4% of ALL)
- of those, **identical input** only 184 calls / 563k chars (2.6% of ALL) — the
  bucket today's dedup already targets
- **redundant** (same-or-narrower range already delivered AND no intervening
  Edit/Write/apply_patch to that path): **551 calls / 1.89M chars = 14.1% of
  Read, 8.7% of ALL**; partial-overlap re-sends add ~166k chars (+0.8%)
- genuinely new view/slice: 1,077 calls / 3.06M chars (22.9% of Read) — not
  elidable, at most deltable

**So D3 ≈ 9.5% of all main-thread tool_result chars (~510k tok over 258
sessions)** — still the biggest single item, but cite this, not 58%. Shape of
the demand: 2,569 range reads vs 1,318 full, 192 outline, 117 symbol; 33.3% of
path-instances are read ≥2×, 141 read ≥5×, tail at 20×; 248 results (5.9%) came
back as an auto-outline.

What exists today, verified in code: the dedup gate at
`FileReadTool.ts:816-824` fires ONLY on `existingState && !isPartialView &&
offset !== undefined && view === undefined && symbol === undefined` plus an
exact `offset`/`limit` match and `mtimeMs === timestamp`, returning
`{type:'file_unchanged'}` with `noResultCache` (`:918-929`). The slice-walk case
— a different range against a prior range — is **telemetry only, explicitly no
behavior change** (`:1124-1141`), and that is exactly the 22.9% bucket.
Constraints any delta reply must clear: gate on `getClippedIds()` like
`GitTool/delta.ts:303`; `isPartialView: true` REFUSES Edit/Write/apply_patch/
NotebookEdit, so a delta must be modelled as a real body or it blocks editing;
`readFileState` is an LRU of 100 entries / 25 MB (`fileStateCache.ts:106,110`),
so an eviction is indistinguishable from a first read; mtime is the only
freshness signal.

### D4 — Make the existing redirects actually fire (52k chars, effort S)
99 Bash calls contained `bun run typecheck`/`tsc --noEmit` (52,471 chars) against
only 15 Typecheck calls; 64 test-ish Bash calls against 117 RunTests calls (mean
337 chars vs 779 for the Bash equivalent). The redirects are narrow by design
(single command, must start with the runner, no quotes, opt-out flags), so most
real invocations escape via compound commands or a trailing `| tail`. Widening the
matcher needs no new tool.

### D5 — Build wrapper (80 calls, 26.5k chars, effort S)
`bun run build` / `bun run smoke` have no wrapper at all and are always followed by
a hand-written `| tail -N`. Natural third member of the
detect/parse/budget/redirect family — see `runtests-tool-language-coverage.md` and
`typecheck-tool-baseline-design.md` for the shape, and reuse
`src/tools/shared/sourceExcerpt.ts`.

## Shared-code debt — PAID 2026-08-04 during D2
`src/tools/shared/redirect.ts` now owns the shell-composition guard, the
output-trim-tail stripper (a FACTORY, because RunTests deliberately excludes
`wc` and Typecheck includes it) and the one-shot memo; RunTests, Typecheck and
`BashTool/toolRedirect.ts` all consume it. `src/tools/shellToolResultMappers.ts`
now exists — its test file had been sitting there without the module — and Bash
and PowerShell share it.

That extraction immediately paid: the shared stripper's argument run swallowed
whole commands chained after the filter (`… | head -30; echo ---; git log -8`
stripped to `git show --stat X`), so a redirect would have suggested a command
with the rest silently dropped. Fixed once, for all three consumers.

Still open: `RunTestsTool` lacks a `budget.test.ts`, and the `budget.ts` caps
themselves were NOT unified — each tool's budget is genuinely different.

Also unblocked along the way: profile scripts that import `src/` died on the
missing `@growthbook/growthbook` (the build stubs analytics, so it is not a
dependency). `scripts/profile/preload-stubs.ts` is the preload —
`bun --preload ./scripts/profile/preload-stubs.ts scripts/profile/<name>.ts`.
The grep replay harness had been silently unrunnable for the same reason.

## Out of scope for now
`PowerShellTool` has no output filter (the `src/tools/shared/outputFilter/Bash/` pipeline is
Bash-only), and that filter's roadmap still defers `aws`/cloud CLIs, DB/secrets
and task runners. Related: [[tool-result-nudges-benched-zero-adoption]] — land any
new nudge flag-OFF as bench instrumentation, and
[[typecheck-ab-bench-fixture-flaw]] for how to A/B one of these honestly.
