---
name: bashfilter sample fixtures are byte-length-sensitive
description: Editing bash-output-filter fixture samples must preserve byte length — the ROI tests under outputFilter/Bash/ assert output-reduction percentages that shift with fixture size
type: feedback
---

**Scope:** this file owns the byte-length rule for EDITING a sample and the
incident that proves it. Where the corpus lives, and which fixtures each harness
actually loads, is [[bash-filter-sample-corpus-unified]].

When editing `src/tools/shared/outputFilter/Bash/__fixtures__/samples/*.txt`, replacements must
be byte-length-preserving.

**Why:** the "ROI" tests assert `reductionPct(raw, body) >= predictedPct - 5`
per sample. They all lived in one `bashFilter.test.ts`; since the 2026-09-19
split they are `assertReduction(filter, command, sample, predictedPct)` calls
spread across the per-family `filters/*.test.ts`, with the helper in
`filters/__testutils__/harness.ts` and `reductionFloors.test.ts` as the roll-up
over every filter that has a real capture. Shortening a fixture shrinks the raw
input and drops the measured reduction: the 2026-07-19 machine-path scrub
(`viudes`→`dev`, 6→3 chars) broke the `ls-la` assertion (70.6% against a 71%
threshold then; the assertion now lives in `filters/ls.test.ts` at 76%) until
re-done with the equal-length `viudes`→`devusr`. Lengthening shifts percentages
the other way and can break tight upper-bound expectations too.

**How to apply:** For any find/replace across the sample dir, pick equal-length
placeholders, and update any test asserting a literal string from a sample (e.g.
the git-worktree test asserts the sample's absolute path). After the edit run
`bun test src/tools/shared/outputFilter/Bash/` — the whole directory, since the
ROI assertions are spread across the per-family suites — and check those
specifically: parse tests can all pass while a reduction test fails.
