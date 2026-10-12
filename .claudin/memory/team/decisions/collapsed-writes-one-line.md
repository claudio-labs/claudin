---
name: collapsed-writes-one-line
description: Since 2026-10-12 a running collapsed group shows its writes on ONE ⎿ line, replaced in place, the way MCP calls do; the stacked per-file rows (up to 8 plus "and N more") are gone; the latest operation of any kind owns the line; no clock on writes
type: project
scope: agent/tools (collapsed read/search group)
impact: functional
paths:
  - "src/agent/tools/collapseReadSearch.ts"
  - "src/agent/ui/messages/CollapsedReadSearchContent.tsx"
---

**Decision:** while a collapsed group runs, Edit/Write/Patch/Rename show one
⎿ line, `A src/c.ts  +4`, replaced as each write lands. They no longer stack
one row per file under the header. The header (`Updating 3 files… +27 −5`),
the finished one-liner and the ctrl+o detail are unchanged.

**Why:** this is the user's call (2026-10-12), asking for the same shape as the
MCP calls ([[mcp-calls-collapse-with-clock]]). A turn with many edits grew
downward until the group finished. The hint above the rows also stayed stale
on the last read, because writes never set it.

**What changes for a teammate:**
- **The latest operation owns the line, whatever its kind.** A read after an
  edit takes the line back.
  - Any new hint site in `collapseReadSearchGroups` must go through
    `setHint`, which hands the line back from a write.
  - A direct `latestDisplayHint =` assignment leaves a stale write on screen.
- **A write the input cannot name gets the line from its result.** This covers
  Rename and relative paths. `recordWriteFile` moves `latestWritePath` on
  every call, so it must stay the only way a file enters `writeFiles`.
- The renderer throttles write vs hint through ONE `useMinDisplayTime`, keyed
  `'\0write:' + path`. The row's +/− is looked up live. Don't give the write row
  a second throttle, or the two lines can show at once.

**Rejected:**
- **Writes always own the line,** as they lead the header. The line would
  look frozen while the agent reads.
- **A batch clock like MCP's.** A write runs in milliseconds, so the span
  would measure the model streaming the next edit. The spinner already shows
  that the group is alive.

Both were the user's picks between offered options.

**Evidence:**
- Plan `.claudin/plans/lively-skipping-puppy.md`, branch
  `feat/collapsed-writes-one-line`.
- Break-probe `scripts/migrations/probes/writeHint.json`: 8 probes, all red.
