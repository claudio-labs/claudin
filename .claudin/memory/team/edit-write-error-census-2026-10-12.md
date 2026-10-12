---
name: edit-write-error-census-2026-10-12
description: Edit/Write error census 2026-10-05..12 — Edit 22/557 (3.9%, was 6.6%), Write 9/389 (2.3%); 19 of 22 Edit errors were its own read lanes, 14 resubmitted byte-identical. ALL FIXED on branch fix/edit-write-census - Edit takes Patch's any-read rule, sub-agent resume rebuilds readFileState, refused Write not restored, Write counts accumulated reads and shows small files, LRU 500
type: project
---

Paired tool_use↔tool_result over every transcript since 2026-10-05, deduped by
tool_use id, `-tmp*` bench projects split out (`census.ts`, `rootcause.ts`,
`followup.ts` in that session's scratchpad, ~60 lines each — rebuild rather
than hunt). Bench-only: 27 memory-guard refusals in memory-write-ab (every
run's first decision write lacked `scope:`/`impact:`; real traffic 1/11) and 2
sensitive-file denials in extract-memories-ab.

**Real traffic.** Edit 22/557: never-read 11, partial-view 8 (all served
regions, so every one was an exact unique match), not-found 2, multi-match 1.
Write 9/389: never-read 4, partial 2, memory guard 1, classifier 2. Over the
month to 10-12 Edit had 176 errors: 138 read gate, 24 not-found, 3 multi-match.
Reaction requests ≈ $5/wk at 300–650k cache-read contexts ($0.15–0.35 each).

**Root causes found, all fixed on `fix/edit-write-census` (2026-10-12):**
- Edit's coverage lane refused an old_string ending with the newline of the
  last line read, and re-refused the identical resubmit (floor.test.ts ×2,
  collapseReadSearch.test.ts; ~9 since 09-12) → the whole lane is gone with
  Edit's gate ([[edit-any-read]]).
- A resumed sub-agent started with an EMPTY readFileState (`resumeAgent.ts`
  passed no fork context, `runAgent.ts` built a fresh cache): 11 of 78 agents
  resumed that week, mostly after a 529 ([[builtin-subagents-skip-529-retry]])
  → rebuilt with `extractReadFilesFromMessages`, as /resume does.
- A refused Write restored as read on resume (`bugs/resume-restores-refused-write`).
- Write refused a whole Read + a range Read as "only read in part (lines
  1-275)" of a 275-line file: `needsWholeFileRead` looked at the last slice
  only → `seenWholeFile` checks the accumulated segments.
- The 100-entry LRU evicted a script the agent had written itself (boot.sh,
  107 paths later); the bare Write refusal sent it to `Read(limit:3)`, then a
  partial refusal, and it abandoned the rewrite → 500 entries, and Write's
  refusal shows files ≤200 lines (`serveWholeFile`).
- Edit's not-found echoed old_string back → now Patch's divergence message
  (`shared/blockMismatch.ts`); multi-match names the lines.

**Review round (3 agents, same day), fixed on the branch:** dropping Edit's
stale lane also dropped the call()-time guard, so a change between validate
and call that made old_string ambiguous edited the FIRST occurrence silently —
call() now recounts. The resume rebuild took an Edit/Patch result's file from
disk with no mtime check, so a resumed sub-agent got its parent's later edits
as "read" — dropped when mtime > result time. The Write refusal capped lines
only (one minified line = megabytes) — 32 KB on the stat; its stale variant
said "resubmit", which would erase the change it shows — now asks for a merge.
`FileState.injectedView` (read by no gate after this) removed.

**Projected by the effect reviewer from the census data:** Edit week 3.95% →
0.54%, month 3.9% → 1.0–1.35% (the rest is pre-served-region September
traffic); Write week 2.3% → 1.3%. Open, not addressed: a never-read Edit of a
short line copied from a SIBLING file can land unread in the wrong file (the
result says unread); one blind Edit leaves a whole-file entry, so the next
Write passes (Patch has the same parity); 9 of the month's 45 Write errors are
"Classifier stage 2 unparseable" denials.

**How to apply:** re-run the census a week after the merge. Expect Edit's
"has not been read yet" only where old_string does not occur exactly once,
no partial/coverage/stale Edit refusals, no "not read yet" on a file read
before a sub-agent resume, and Edit near 0.5% (model errors only).
