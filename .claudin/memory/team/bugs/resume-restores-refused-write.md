---
name: resume-restores-refused-write
description: FIXED 2026-10-12 (fix/edit-write-census) - extractReadFilesFromMessages rebuilt a Write's read-state entry from its input without checking is_error, so a REFUSED Write counted as read after --resume
type: project
---

**Symptom:** after `--resume`, a file whose Write was refused ("has not been
read yet", say) counted as read, so the next Write or Edit on it passed the
read-before-edit gate although the model never saw the file.

**Where:** `src/agent/queryHelpers.ts`, the Write branch of the second pass
(`fileWriteToolUseIds`) set the entry from the tool_use input with no
`is_error` check. The Edit/Patch branches and the Bash credit branch skipped
error results.

**Status (2026-10-12): FIXED** on `fix/edit-write-census` — the Write branch
requires `content.is_error !== true`, pinned in
`queryHelpers.extractReadFiles.test.ts` ("a refused Write restores nothing")
and break-probed in `scripts/migrations/probes/editWriteCensus.json`. Fixed
then because the sub-agent resume started rebuilding its state through the
same function ([[edit-write-error-census-2026-10-12]]).
