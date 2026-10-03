---
name: mcp-server-name-folding-reaches-other-servers-rules
description: An MCP server whose name folds to contain "__" parses back as a shorter server, so permission rules written for that server reach its tools; and a repo's own .claudin/settings.json can approve its own .mcp.json servers
type: project
---

Found by the `mcp/core` characterization on 2026-10-03, branch `rewrite`.
The current behaviour is pinned in `src/mcp/core.*.characterization.test.ts`,
and the decision for now is "keep for parity". Neither is fixed.

**1. Server-name folding crosses servers.**
- A tool's wire name is `mcp__<server>__<tool>`. Server names are normalized,
  and characters outside `[A-Za-z0-9_-]` become `_`.
- So a server named `team__ops`, or `team  ops`, `team..ops`, or one with an
  emoji, produces `mcp__team__ops__<tool>`, which parses back as server `team`.
- A user's allow rule for server `team` then also allows the tools of the other
  server.
- A project `.mcp.json` can choose that name, so this is a permission
  escalation path.
- Names that fold together (`my.server` and `my_server`) also share their
  approval, their rules and their tools.

**2. A repository can approve its own MCP servers.**
- A checkout's `.claudin/settings.json` can set `enabledMcpjsonServers` or
  `enableAllProjectMcpServers`.
- Either setting approves the same checkout's `.mcp.json` servers without the
  approval dialog. This was checked with real files.

**Why:** both decide what runs from a checkout the user did not write.

**How to apply:**
- Decide on fixes when `mcp/core` and `mcp/approvalDialogs` / `permissions/sessionDialogs`
  are rewritten (phase 3).
- For 1: refuse, or escape, a server name that folds to contain `__`.
- For 2: ignore those two keys when they come from project scope.
- Fixing either changes a pin in the characterization suites, in the same commit.
