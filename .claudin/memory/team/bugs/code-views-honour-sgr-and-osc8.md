---
name: code-views-honour-sgr-and-osc8
description: Escape sequences in file content reach the terminal in code views — SGR can hide part of a line, OSC 8 plants a clickable link; FIXED in the structured diff 2026-09-28, HighlightedCode and /diff's pane still unchecked
type: project
---

**Symptom:** none visible until a file carries raw escape bytes. An added line holding `ESC[8m` (conceal), or a foreground set to its background, shows `x = 1` in the edit-permission dialog while also carrying a command. An OSC 8 sequence shows harmless text that opens any URL when clicked. The terminal renderer (`src/terminal/ink`) already drops cursor moves, screen clears, clipboard writes and bells; styling and hyperlinks inside a line pass through.

**Where:** the structured diff (`src/vcs/diff/structured/`), on both the highlighted and the plain path. Neither `src/terminal/highlighted-code/` (file previews) nor `src/vcs/diff/ui/` (the /diff pane) strips escapes either; whether they pass SGR/OSC 8 through was not tested.

**Status 2026-09-28:** fixed in the structured diff. Its clean-base rewrite runs one sanitizer (`src/vcs/diff/structured/hunk/sanitize.ts`) before both paths, stripping escape sequences with their payloads and every control character but tab, DEL and C1 included; tests and probes pin it. Still open: check `src/terminal/highlighted-code/` and `src/vcs/diff/ui/` with a file holding `ESC[8m` and an OSC 8 link before assuming they are safe, and reuse that sanitizer if they are not.
