import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react';
import instances from 'src/terminal/ink/instances.js';
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from 'src/terminal/ink/termio/dec.js';
import { TerminalWriteContext } from 'src/terminal/ink/useTerminalNotification.js';
import Box from 'src/terminal/ink/components/Box.js';
import { TerminalSizeContext } from 'src/terminal/ink/components/TerminalSizeContext.js';
type Props = PropsWithChildren<{
  /** Enable SGR mouse tracking (wheel + click/drag). Default true. */
  mouseTracking?: boolean;
  /**
   * Whether the alt screen is entered at all. Default true. Toggling this
   * instead of mounting/unmounting the component keeps `children` mounted
   * across the switch — the REPL root relies on it to visit the alt screen
   * without remounting the app (MCP connections included).
   */
  active?: boolean;
  /**
   * The session is inline and will come back to the main screen: on exit,
   * diff from the main-screen frame as it was instead of repainting, so
   * what rendered meanwhile is appended to the scrollback. See
   * `Ink.setAltScreenActive`.
   */
  preserveMainScreen?: boolean;
}>;

/**
 * Run children in the terminal's alternate screen buffer, constrained to
 * the viewport height. While mounted:
 *
 * - Enters the alt screen (DEC 1049), clears it, homes the cursor
 * - Constrains its own height to the terminal row count, so overflow must
 *   be handled via `overflow: scroll` / flexbox (no native scrollback)
 * - Optionally enables SGR mouse tracking (wheel + click/drag) — events
 *   surface as `ParsedKey` (wheel) and update the Ink instance's
 *   selection state (click/drag)
 *
 * On unmount, disables mouse tracking and exits the alt screen, restoring
 * the main screen's content. Safe for use in ctrl-o transcript overlays
 * and similar temporary fullscreen views — the main screen is preserved.
 *
 * Notifies the Ink instance via `setAltScreenActive()` so the renderer
 * keeps the cursor inside the viewport (preventing the cursor-restore LF
 * from scrolling content) and so signal-exit cleanup can exit the alt
 * screen if the component's own unmount doesn't run.
 */
export function AlternateScreen({
  children,
  mouseTracking = true,
  active = true,
  preserveMainScreen = false
}: Props) {
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  useInsertionEffect(() => {
    if (!active) {
      return;
    }
    const ink = instances.get(process.stdout);
    if (!writeRaw) {
      return;
    }
    writeRaw(ENTER_ALT_SCREEN + "\x1B[2J\x1B[H" + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""));
    ink?.setAltScreenActive(true, mouseTracking, preserveMainScreen);
    return () => {
      ink?.setAltScreenActive(false);
      ink?.clearTextSelection();
      writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : "") + EXIT_ALT_SCREEN);
    };
  }, [writeRaw, mouseTracking, active, preserveMainScreen]);
  // The same Box either way, so switching `active` never changes the tree
  // shape under it; only the viewport-height constraint comes and goes.
  return <Box flexDirection="column" height={active ? size?.rows ?? 24 : undefined} width="100%" flexShrink={0}>{children}</Box>;
}
