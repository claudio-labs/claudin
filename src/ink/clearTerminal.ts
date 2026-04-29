/**
 * Cross-platform terminal clearing.
 *
 * Preserves native terminal scrollback — only the visible viewport is cleared.
 * ERASE_SCROLLBACK (\x1B[3J) is intentionally NOT emitted, so layout reshapes
 * triggered by log-update.ts (resize / shrink / offscreen / cursor-out-of-viewport)
 * do not wipe the user's history. This keeps parity with two other clear paths
 * in the fork that already make this choice: forceRedraw() in ink.tsx (Cmd+K
 * external clear) and exitAlternateScreen() (avoids wiping main-screen
 * scrollback on rmcup).
 */

import { CURSOR_HOME, csi, ERASE_SCREEN } from './termio/csi.js'

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * Returns the ANSI escape sequence to clear the visible viewport.
 * Native terminal scrollback is preserved across all platforms.
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32' && !isModernWindowsTerminal()) {
    // Legacy Windows console only understands HVP for cursor home.
    return ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + CURSOR_HOME
}

/**
 * Clears the visible viewport. Does NOT clear scrollback — see file header.
 */
export const clearTerminal = getClearTerminalSequence()
