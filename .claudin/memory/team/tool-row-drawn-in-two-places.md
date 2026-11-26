---
name: tool-row-drawn-in-two-places
description: A tool row header ("● Name(args)") is drawn by AssistantToolUseMessage, by CollapsedReadSearchContent's per-message detail (ctrl+o), AND by a tool's renderGroupedToolUse header when one turn makes 2+ calls (Agent, Edit); a change to one misses the others
type: project
---

A tool row's header is rendered in three independent places:

1. `src/agent/ui/messages/AssistantToolUseMessage.tsx` — a standalone row (Bash outside fullscreen,
   Agent, an errored MCP call, anything that does not group).
2. `src/agent/ui/messages/CollapsedReadSearchContent.tsx`, the per-message detail of a collapsed
   group — builds its own `header` from `tool.userFacingName` + `tool.renderToolUseMessage`
   (MCP calls via `renderMcpCallLine`). This is what ctrl+o shows for every grouped call.

In prompt mode Read/Grep/Glob and (with collapsed writes on) Edit/Write/Patch fold into "Read N
files" / "Updated N files", so their individual rows exist **only** in (2).

3. A tool's own `renderGroupedToolUse` — the header of 2+ calls of the same tool from one turn
   ("2 background agents launched"): `renderGroupedAgentToolUse` in `src/tools/AgentTool/UI.tsx`
   and `renderGroupedFileEditToolUse` in `src/tools/FileEditTool/UI.tsx`. It gets the icons as
   `options.rowIcons(input)`, which `GroupedToolUseContent.tsx` binds to `getToolRowIcons` with the
   tool and `useNerdFontGlyphs()`, so a grouped renderer needs no hook and no icon import.

**Why:** on 2026-11-24 the Nerd Font tool-row icons (branch `feat/ui-adjustments`) were planned and
wired into (1) only. Unit and render tests were green; the first live ctrl+o check showed
`● Write(…)` / `● Update(…)` with no icon while `● 󰆍 Bash(…)` had one. It took a second round to
add the same `getToolRowIcons` call to (2). On 2026-11-26 the user saw (3): two background agents
still showed a blinking ● where a single Agent row showed the robot. Both grouped headers take
the icons since (#369); the Edit one also has the file-type icon before the path.

**How to apply:** any change to how a tool row's name or args look (icons, colors, a prefix, a
label) goes in all three, with a render test for each. Verify under ctrl+o and with 2+ parallel
calls on a live build, not only a single row in the prompt view.
`src/agent/ui/tasks/renderToolActivity.tsx` is a fourth, smaller caller (background-agent activity
lines), not a row header.
