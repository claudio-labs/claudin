---
name: code-views-honour-sgr-and-osc8
description: Escape sequences in file content reach the terminal in code views — SGR can hide part of an added line in a permission-dialog diff, OSC 8 plants a clickable link; the diff renderer's rewrite strips them, HighlightedCode and /diff's pane unchecked (2026-09-28)
type: project
---

**Symptom:** none visible until a file carries raw escape bytes. An added line holding `ESC[8m` (conceal), or a foreground set to its background, shows `x = 1` in the edit-permission dialog while also carrying a command. An OSC 8 sequence shows harmless text that opens any URL when clicked. The terminal renderer (`src/terminal/ink`) already drops cursor moves, screen clears, clipboard writes and bells; styling and hyperlinks inside a line pass through.

**Where:** the structured diff (`src/vcs/diff/structured/`), on both the highlighted and the plain path. Neither `src/terminal/highlighted-code/` (file previews) nor `src/vcs/diff/ui/` (the /diff pane) strips escapes either; whether they pass SGR/OSC 8 through was not tested.

**Status 2026-09-28:** the clean-base rewrite of the structured diff strips escape sequences and C0 controls (tab excepted) from each hunk line as hardening (`docs/tech/rewrite/vcs/structuredDiff.md`, Security requirements). Check the other two views with a file holding `ESC[8m` and an OSC 8 link before assuming they are safe.
