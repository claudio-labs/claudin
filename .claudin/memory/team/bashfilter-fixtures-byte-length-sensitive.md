---
name: bashfilter sample fixtures are byte-length-sensitive
description: Editing bash-output-filter fixture samples must preserve byte length — ROI tests in bashFilter.test.ts assert output-reduction percentages that shift with fixture size
type: feedback
---

When editing `src/tools/shared/outputFilter/Bash/__fixtures__/samples/*.txt`, replacements must
be byte-length-preserving. (There used to be a mirrored copy under
`docs/discovery/bash-output-filter/validation/samples/`; it was merged away on
2026-08-06 and that path no longer exists — see
[[bash-filter-sample-corpus-unified]]. Do not recreate it.)

**Why:** `bashFilter.test.ts` "ROI" tests assert `reductionPct(raw, body) >=
predictedPct - 5` per sample. Shortening a fixture shrinks the raw input and drops
the measured reduction: the 2026-07-19 machine-path scrub (`viudes`→`dev`, 6→3
chars) broke the `ls-la` assertion (70.6% < 71% threshold) until re-done with the
equal-length `viudes`→`devusr`. Lengthening shifts percentages the other way and
can break tight upper-bound expectations too.

**How to apply:** For any find/replace across the sample dir, pick equal-length
placeholders, and update any test asserting a literal string from a sample (e.g.
the git-worktree test asserts the sample's absolute path). After the edit run
`bun test src/tools/shared/outputFilter/Bash/bashFilter.test.ts` and check the ROI assertions
specifically — parse tests can all pass while a reduction test fails.
