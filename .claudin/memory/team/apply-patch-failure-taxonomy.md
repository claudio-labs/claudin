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

`prompt.ts` was deliberately NOT touched: its DESCRIPTION is frozen per session in
the cached tool block, so any byte change invalidates the whole prompt cache, and
the strict format is still what the model should aim for.
