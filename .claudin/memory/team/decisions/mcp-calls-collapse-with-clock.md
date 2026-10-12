---
name: mcp-calls-collapse-with-clock
description: Since PR 284 (2026-10-10) every MCP call collapses into the read/search group as "Calling <server> N times · 12s", the clock spanning the whole batch and frozen once done; errored MCP calls leave the group so failures stay visible
type: project
scope: agent/tools (collapsed read/search group), tools/MCPTool
impact: functional
paths:
  - "src/agent/tools/collapseReadSearch.ts"
  - "src/tools/MCPTool/McpElapsedTime.tsx"
  - "src/tools/MCPTool/callLabel.ts"
---

**Decision:** every MCP call collapses into the group's MCP category. Before, only the
whitelisted search/read ones did. The verb is Calling/Called, which replaced
Querying/Queried. A clock follows the MCP part:
- It measures the batch, from the earliest `startedAt` to the last call's end.
- It is live while any MCP call runs.
- It freezes at the total once every call has a terminal tick.
- It is hidden under 2 s, the shell's threshold.

An errored MCP call leaves the group (`isErroredWriteToolUse` extended to
`mcpServerName`).

**Why:** this is the user's choice, from Claude Code 2.1.296 screenshots
(`Calling … N times`). A slow server such as context7 or a remote HTTP MCP looked
frozen with no clock. The error carve-out is not optional. The finished badge has
no error marker, so collapsing every call without it would hide timeouts and auth
failures that used to show on their own rows.

**What changes for a teammate:**
- **A resumed session shows `Called …` with no time.** Progress messages are not
  persisted (`sessions/pure/logging.ts`). That is the intended graceful case; don't
  file it as a bug.
- **Every `MCPProgress` tick carries `startedAt`.** `queryMessages.ts` replaces each
  tick with the next, so a server that sends progress notifications overwrites the
  `started` message. Keep `startedAt` on any new tick kind, or the clock loses its
  anchor.
- **Don't shrink back to a whitelist** without asking the user. It was their call.

**Follow-up (2026-10-11), also the user's call, from a Codex screenshot:**
- **Detail view (ctrl+o):** each call reads `Called server.tool({json})`.
  - The arguments are the model's compact JSON.
  - The result is shown as the server sent it, with no pretty-printing (`OutputLine rawJson`) and no cut.
- **Running hint:** the ⎿ line shows the same `server.tool({json})` for the latest call, capped at 300 chars like a command.
- Both come from `src/tools/MCPTool/callLabel.ts`.
- **Left as they were, on purpose:**
  - the permission prompt keeps the `key: value` list;
  - an errored call, outside the group, keeps the old header.

**Rejected:**
- **Anchoring the clock on the `started` message alone**, which gets overwritten.
- **The shell's "slowest running call" rule.** It drops to 0 between serial calls.

**Evidence:**
- Plan `.claudin/plans/snoopy-gathering-dongarra.md`.
- PR 284.
- Break-probe `scripts/migrations/probes/mcpElapsed.json`.
