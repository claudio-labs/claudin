---
name: transcript-ui-round-2026-11-24
description: Since 2026-11-24 a Nerd Font terminal draws each tool's icon in place of the row's ● (the status in its color), icons on collapsed-badge parts, todos, the mode footer and AskUserQuestion tabs; tool results carry no ⎿ (only harness lines do, via `mark`); the spinner verb names the running tools; the thinking status and the orb glyph are gone
type: project
scope: agent/ui (transcript rows, spinner)
impact: functional
paths:
  - "src/terminal/terminalFont.ts"
  - "src/agent/ui/messages/toolRowIcons.ts"
  - "src/agent/ui/MessageResponse.tsx"
  - "src/agent/ui/messages/toolActivityLabel.ts"
  - "src/terminal/spinner/Spinner.tsx"
---

**Decision:** the user's calls on `feat/ui-adjustments` (2026-11-24), round by round.
- **Nerd Font icons** (`hasNerdFontGlyphs()`):
  - The tool's icon takes the row's `●` and its status: green fade while running, red on an error,
    dim while pending, default color once done.
  - File tools add a colored file-type icon before the path. The ctrl+o detail rows match.
  - Each collapsed-badge part leads with its action's icon, and the badge drops its dot column.
  - Todos, the footer mode and the AskUserQuestion tabs swap to nf-md glyphs.
  - Without the font, output is main's byte for byte; the snapshot in `nerdFontFallback.test.tsx`
    was recorded on main.
- **Detection:** `CLAUDIN_NERD_FONT` > `/config` "Nerd Font icons" (auto/on/off) > the terminal
  heuristic. The markers that survive into tmux (`GHOSTTY_RESOURCES_DIR` …) count only when tmux
  or screen is in front: any emulator started from such a shell inherits them.
- **Text that leaves the terminal** (`/export`, the ctrl+e transcript) renders without icons,
  through `NerdFontGlyphsContext`. The `[` dump to scrollback keeps them.
- **Result bodies have no ⎿.** Only what the harness adds around a result keeps it
  (`<MessageResponse mark>`: a timeout, a background command, a hook). The gutter is `"  ⎿ "`,
  4 columns.
- **The spinner verb says what the agent is doing** (`describeActivity`): the running tools, else
  the todo in progress, else the mode's verb. Random verbs (`spinnerVerbs`) are teammates' only.
  The "thinking with X effort" / "thought for Ns" status and the orb glyph are gone for every
  terminal; the user kept that when the review flagged reduced motion.

**What changes for a teammate:**
- A change to how a tool row looks goes in all three renderers ([[tool-row-drawn-in-two-places]]).
- A component that draws icons reads `useNerdFontGlyphs()`, not `hasNerdFontGlyphs()`, or
  `/export` writes the codepoints.
- A result renderer adds no ⎿ of its own: `UserToolSuccessMessage` wraps it in `ToolResultBody`.
  A secondary line inside a result passes `mark`. `src/__tests__/toolResultGutter.test.ts` fails
  on `⎿` followed by two spaces.

**Rejected:**
- **Keep the `●` and add the icon beside it:** the plan's first pick, replaced in a later round.
- **Build the verb from `Tool.getActivityDescription`:** it is a progress line's sentence
  ("Running <the command's description>") and cannot promise three words.

**Evidence:**
- Plan `.claudin/plans/frolicking-rolling-liskov.md`.
- Break-probe specs `nerdFontIcons.json`, `toolResultMarks.json` and `spinnerActivity.json`, all
  red. A 3-agent review found three bugs after a green 19k-test suite; they are fixed, with tests.
