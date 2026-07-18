---
name: Live-verifying TUI mouse click/hover under tmux
description: How to drive and confirm clickable/hover tool-result UI (Box onClick) in claudindev under tmux — fullscreen env + SGR mouse injection
type: reference
---

Claudin only captures the mouse in **fullscreen/alt-screen** mode. By default the
REPL runs inline (`tmux display -p '#{mouse_any_flag}'` → 0, `#{alternate_on}` →
0), so `Box onClick`/`onMouseEnter` never fire and any injected click is ignored.

**To verify a clickable/hover tool-result interaction (e.g. apply_patch's
collapsible groups, message-row expand, pills):**

1. Launch with fullscreen forced so mouse tracking turns on:
   `CLAUDE_CODE_NO_FLICKER=1 claudindev` (see `src/utils/fullscreen.ts` —
   `isFullscreenEnvEnabled` / `isMouseTrackingEnabled`). Confirm with
   `tmux -L <sock> display -p -t t '#{mouse_any_flag}'` → should be `1`,
   `#{alternate_on}` → `1`.
2. Find the target row's 1-based pane coordinates with
   `tmux capture-pane -t t -p | cat -n`.
3. Inject an SGR mouse click (button 0) straight into the app's stdin — bypasses
   tmux's own mouse handling, so tmux `mouse` option state doesn't matter:
   `tmux send-keys -t t -l $'\033[<0;COL;ROWM'` (press) then
   `tmux send-keys -t t -l $'\033[<0;COL;ROWm'` (release).
4. `capture-pane` again to see the toggle. Re-inject to confirm it toggles back.

**Why:** mouse-interaction features can't be unit-tested (ink modules are
build-stubbed under `bun test`), and inline-mode captures silently no-op. This is
the only way to confirm the click path end-to-end at runtime.

**Caveats:** keyboard fallback (`ctrl+o` global verbose / expand-all) works in
inline mode and is easier to drive (`send-keys C-o`) — use it to verify the
expanded RENDER; use the SGR injection above only to verify the CLICK toggles
local state. Hover-bold can't be captured statically (mouse isn't held during
capture); it shares the same `Box onMouseEnter` path as the verified click.
