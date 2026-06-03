import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

// Terminals that ship with (or are commonly paired with) a Nerd Font in
// their default install / quick-start docs. This is a *heuristic* — users
// can run Alacritty with a Nerd Font configured and we'd miss it; they can
// also run Ghostty with the default font swapped out. The env-var override
// below is the escape hatch for both cases.
const NERD_FONT_TERMINALS = new Set([
  'ghostty',
  'kitty',
  'WezTerm',
  'iTerm.app',
  'WarpTerminal',
])

const NERD_FONT_TERM_PATTERNS = ['kitty', 'ghostty', 'wezterm']

/**
 * Returns true when the active terminal is likely to render Nerd Font /
 * Powerline glyphs (U+E0A0–U+E0D7, etc.). Resolution order:
 *
 *   1. `CLAUDIN_NERD_FONT=on/1/true` → force on
 *   2. `CLAUDIN_NERD_FONT=off/0/false` → force off
 *   3. `TERM_PROGRAM` in the known-good list → on
 *   4. `TERM` contains a known-good keyword (e.g. `xterm-kitty`) → on
 *   5. otherwise → off (Alacritty, xterm, gnome-terminal, generic ssh)
 *
 * The conservative default (off when unknown) means callers get safe
 * ASCII fallback in unfamiliar terminals; users with Nerd Font configured
 * outside the known set opt in via the env var.
 */
export function hasNerdFontGlyphs(): boolean {
  const override = process.env.CLAUDIN_NERD_FONT
  if (isEnvTruthy(override)) return true
  if (isEnvDefinedFalsy(override)) return false

  const termProgram = process.env.TERM_PROGRAM
  if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true

  const term = process.env.TERM?.toLowerCase() ?? ''
  if (NERD_FONT_TERM_PATTERNS.some(p => term.includes(p))) return true

  return false
}
