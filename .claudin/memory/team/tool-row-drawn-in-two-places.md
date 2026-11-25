---
name: tool-row-drawn-in-two-places
description: A tool row header ("● Name(args)") is drawn by AssistantToolUseMessage AND by CollapsedReadSearchContent's per-message detail (ctrl+o); most Read/Grep/Glob/Edit/Write rows are only ever seen through the second, so a change to one misses them
type: project
---

A tool row's header is rendered in two independent places:

1. `src/agent/ui/messages/AssistantToolUseMessage.tsx` — a standalone row (Bash outside fullscreen,
   Agent, an errored MCP call, anything that does not group).
2. `src/agent/ui/messages/CollapsedReadSearchContent.tsx`, the per-message detail of a collapsed
   group — builds its own `header` from `tool.userFacingName` + `tool.renderToolUseMessage`
   (MCP calls via `renderMcpCallLine`). This is what ctrl+o shows for every grouped call.

In prompt mode Read/Grep/Glob and (with collapsed writes on) Edit/Write/Patch fold into "Read N
files" / "Updated N files", so their individual rows exist **only** in (2).

**Why:** on 2026-11-24 the Nerd Font tool-row icons (branch `feat/ui-adjustments`) were planned and
wired into (1) only. Unit and render tests were green; the first live ctrl+o check showed
`● Write(…)` / `● Update(…)` with no icon while `● 󰆍 Bash(…)` had one. It took a second round to
add the same `getToolRowIcons` call to (2).

**How to apply:** any change to how a tool row's name or args look (icons, colors, a prefix, a
label) goes in both files, with a render test for each. Verify under ctrl+o on a live build, not
only the prompt view. `src/agent/ui/tasks/renderToolActivity.tsx` is a third, smaller caller
(background-agent activity lines), not a row header.
