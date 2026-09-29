---
name: apply-patch-failure-taxonomy
description: apply_patch fails 11.9% vs Edit 4.6% — measured breakdown, what is model error vs tool strictness, and the four parse repairs landed 2026-08-15
type: project
---

Measured over 682 sessions (`~/.claudin/projects/**/*.jsonl`, 2026-07-15 → 08-15):
**1,867 `apply_patch` calls, 222 errors = 11.9%**, against Edit 4.6% (n=3,627) and
Write 1.8% (n=932). Failed payloads are 16.2% of all patch bytes ever sent (~200k
tokens of pure re-send).

Where the 222 fail — the split is the point, because only the last third was ours:

- **read gates 119 (53.6%)** — never-read 56, coverage 28, partial-view 21, stale 12.
  Not a parser problem, but multiplied by atomicity: per-file gate failure is ~4%,
  so error rate by patch size runs 1 file 9.4% → 2 files 21.4% → **5+ files 38.5%**.
  Failing patches average 2.46 files / 4.88 hunks; succeeding ones 1.40 / 2.10.
- **apply-time context mismatch 68 (30.6%)** — genuine model error. The matcher
  already runs the 4-pass fuzzy ladder plus fragment-anchor and trailing-blank
  rescues; don't "fix" this side, there is nothing left to loosen safely.
- **parse 25 (11.3%)** — pure tool strictness, all deterministically repairable.

Two hypotheses **ruled out** on the data, so don't re-investigate them: the model
never batches Read and the patch in one assistant message (0 of 1,867), and it does
not abandon the tool after a failure (172 retry `apply_patch`, 36 fall back to Edit;
1.17 failed attempts before success). Cold start is real though — the first patch of
a session fails 21.1%. By model: opus-5 12.9% (n=1374), sonnet-5 7.0% (n=431).

## The four parse repairs (patchFormat.ts, 2026-08-15)

Each replaces a loud throw with a deterministic repair — the third option between
opencode's silent-drop and our reject-the-batch:

1. **Missing envelope** (14 of 25: 9 lost Begin, 5 lost End) → `locateEnvelope`
   synthesizes it when a section header is present. Safe because a tool call
   arrives as complete JSON: a truncated emit is not callable at all.
2. **Unprefixed body line** (6) → taken as context, WHOLE line. A `+` the model
   forgot then fails at apply time with the divergence point named, instead of
   rejecting an N-file patch at parse time.
3. **Change lines before the first `@@`** (2) → implicit bare chunk.
4. **`*** Update File:` repeated for the same file** (2, absolute then relative)
   → the first header is dropped; a repeat naming a *different* file still throws.

Validated by replaying all 1,870 real payloads through both parsers: **1,845 parse
byte-identically, 25 rescued, 0 regressed, 0 changed**. Keep that replay in mind
before touching this parser again — leniency changes must be diffed against the
corpus, not argued about.

**5. Unprefixed Add File line (2026-09-29)** → kept as content, WHOLE line: an
Add body holds nothing else. Replay of 6,671 real payloads: 6,544 identical, 2
rescued (a 434-line doc patch sunk by one markdown line; a Go test file written
raw after its first `+`), 0 regressed, 0 changed.

**Position misses are most of the "context mismatch" bucket (2026-09-29).** Of 85
real hunks failing with "none of the N line(s) below appear at or after line K",
65 had their lines re-sent verbatim by a patch that applied (an upper bound).
Strictly, the retry for that file was the SAME hunks only reordered in 38 of 83
sections: 36 of 81 failed calls were pure reorders, and their retries cost 123k
output tokens (~3.4k per event, almost all Opus). Verified on the bench's three
cases ([[build-project-ab-bench-2026-09-29]]): bare-`@@` hunks sent at lines
79→11 and 51→20. Sorted, they apply byte-identical to the model's own retry.
Cause: `computeReplacements` searches each body from a cursor that only
advances, while the applier already sorts and guards overlaps. The body
message ("written from memory") never looks before the cursor, unlike the
anchor one. prompt.ts recommends a bare `@@` as the safe choice without saying
that hunks must follow file order.

**6. Out-of-order bare hunk (2026-09-29)** → FIXED. A bare `@@` chunk (no
anchor, no End of File) not found at or after the cursor takes the block's
unique match anywhere in the file (`findAllByLadder`: the tightest pass that
matches decides). The cursor never moves back, and the existing sort plus
overlap guard handle the rest. Anchored chunks are never moved. The miss
message now names the line(s) where the block sits above the search start.
All 38 real reorder sections were bare. The TDD red run was 5/6 tests;
`scripts/migrations/probes/patchOutOfOrderHunks.json` has 7 probes, all red.
Both bench patches now apply as sent, byte-identical to the model's retry.

**7. The rest of the re-send: atomicity itself (2026-09-29)** → FIXED by
[[patch-applies-what-matches]]. After the reorder fix, 115 real failed calls
still had a retry: 603k chars, of which 227k were sections that had not failed
and 146k hunks that had not failed inside failing sections — ~62% re-sent only
because nothing was written. The remaining categories: content wrong (36
sections, a real model error), retry dropped hunks (6), no retry (2 unique: the
model gave up on Patch and rewrote the file with Write/Edit). Patch now applies
what matches and lists the rest, so a retry carries only the failed hunks.

`prompt.ts` changed with #7 only: the atomic/all-or-nothing lines became the
partial rule, since they had become false. Its DESCRIPTION is frozen per
session in the cached tool block, so edit it only when it stops being true.
