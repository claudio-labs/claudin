---
name: apply-patch-any-read
description: apply_patch accepts any prior read since 2026-09-24 (outline, range, symbol, clipped, injected, changed on disk) — only a never-read file is refused; the hunk's own context match at apply time is the check. Edit/Write/NotebookEdit keep the full gate.
type: project
scope: tools/apply_patch
impact: functional
paths:
  - "src/tools/ApplyPatchTool/applyPatch.ts"
  - "src/tools/shared/readBeforeEditMessages.ts"
---

**Decision:** `validateApplyPatchInput` refuses an Update or Delete only when
the file has no `readFileState` entry at all (still served + `*** Resubmit`).
The partial-view, clipped, coverage, whole-file-for-Delete and stale refusals
are gone; `stageHunk` matching the hunk against the file on disk is the check.
The tool prompt now says any Read counts and nothing has to be re-read.

**Why:** user decision after the 2026-09-23 session A/B: claudindev spent 5.8
turns before its first edit against Claude Code's 2.3, reading and re-reading
because the prompt and the gate demanded it. The census already showed the
refusals bought little — half the coverage ones and 17 of 30 stale ones came
back as the identical patch ([[tool-error-census-2026-09-20]]).

**What changes for a teammate:**
- A patch after an outline-only or range read applying is intended. Do not
  "restore" the four-tool invariant without a measurement; `.claudin/rules/cache.md`
  now states a three-tool invariant plus this exception.
- apply_patch coverage/stale refusals are zero by construction from 09-24 —
  a census comparing against earlier weeks must not read that as a fix.
- `readGateScenarios.test.ts` observes coverage/partial/stale through Edit now;
  S19 pins this policy, `scripts/migrations/probes/patchAnyRead.json` proves it.
- A Bash `cat` still does not count (the read credit stays off,
  [[bash-read-passthrough-not-promoted]]).

**Rejected:** keeping the gate and serving every refusal's lines — still one
round-trip per refusal.

**Evidence:** headless claudindev run, Read(view='outline') then apply_patch
inserting above `fn37`: applied first try, 3 turns. The A/B re-run is pending.
