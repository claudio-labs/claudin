---
name: resume-restores-refused-write
description: extractReadFilesFromMessages rebuilds a Write's read-state entry from its input without checking is_error — a REFUSED Write counts as read after --resume
type: project
---

**Symptom:** after `--resume`, a file whose Write was refused ("has not been
read yet", say) counts as read, so the next Write or Edit on it passes the
read-before-edit gate although the model never saw the file.

**Where:** `src/agent/queryHelpers.ts`, the Write branch of the second pass
(`fileWriteToolUseIds`, ~:729) sets the entry from the tool_use input with no
`is_error` check. The Edit/Patch branches and the Bash credit branch skip
error results.

**Repro:** a transcript holding a Write tool_use answered `is_error: true`, fed
to `extractReadFilesFromMessages` → the entry is there.

**Status (2026-09-24):** found while planning `perf/cat-read-and-batch-read`
and left out of that diff on purpose; the fix is one guard plus a case in
`queryHelpers.extractReadFiles.test.ts`.
