---
name: patch-applies-what-matches
description: Since 2026-09-29 Patch is no longer all-or-nothing — each hunk/section applies, is already applied, or is NOT applied with its reason; a never-read file is patched when every hunk matches exactly; `*** Resubmit` retired; CLAUDIN_PATCH_ALL_OR_NOTHING=1 restores the atomic patch
type: project
scope: tools/ApplyPatchTool
impact: functional
---

**Decision:** Patch applies every change that matches and reports the rest
(user, 2026-09-29: "parar de recusar patch e sanar os erros das chamadas").
- Each Update hunk, Add, Delete or Move is applied, already applied (its
  result is on disk: a patch sent twice, an Add with identical content, a
  Delete of a file already gone) or NOT applied with the reason. Every file with
  an applied change is written; a partial result is a SUCCESS listing
  `NOT applied — send a patch with only these hunks`, and `then` is skipped.
  Nothing written and something failed is still an error.
- Every failing hunk of a file is reported, not just the first; several Update
  sections of one file compose (each matched against the original, overlap
  guarded).
- A file never read is patched when every hunk's old side matches it exactly
  and uniquely (the result says so); otherwise NOT applied with "Read it
  first". A Delete of a never-read file is not applied.
- Validation refuses only a patch that does not parse or in which nothing can
  apply. `*** Resubmit` and `CLAUDIN_DISABLE_PATCH_RESUBMIT` are gone; old
  transcripts still resolve the sentinel on resume.
- Killswitch `CLAUDIN_PATCH_ALL_OR_NOTHING=1`: any change not applied fails
  the call with nothing written, and validation refuses every file-level
  problem up front, with the never-read lines served.

**Why:** the atomic patch made the model re-send everything to fix one hunk:
115 real retries, 603k chars, ~62% of them hunks that would have applied
([[apply-patch-failure-taxonomy]]). The never-read gate cost +1 call on 5.1%
of Patch calls since 09-24, and 88% came back as the identical patch; 82% of
those files had been seen through Bash, most of the rest through Grep —
counting Bash reads failed its A/B ([[read-files-ab-2026-09-29]]).

**What changes for a teammate:**
- `runApplyPatch` now holds the read gate itself: a test calling it directly
  must `markRead` a file it Deletes.
- Resume restores the files a Patch wrote from `toolUseResult.files`
  (`queryHelpers.ts`), because a partial patch's input names files it did not
  write.
- Probes: `scripts/migrations/probes/patchApplyWhatMatches.json` (18, all red);
  `patchResubmit.json` keeps only the resolveInput plumbing and resume probes.

**Rejected:** keep the patch refused but hold its good sections for a
`*** Resubmit` + amendments protocol — it still refused, and put hidden state
and merge rules on top (plan of 2026-09-29, rejected by the user as not
elegant).

**Evidence:** TDD red → green (12 new applyPatch tests, 9 applySections
tests, 1 resume test); live claudindev (Sonnet 5.5): a 3-file patch with one
stale hunk applied 2 files, and the next call carried only the corrected hunk
(4 turns, $0.09); an unread exact-match file patched with the note. Benches:
see [[build-project-ab-bench-2026-09-29]] round 4 and
[[read-files-ab-2026-09-29]] round 2.
