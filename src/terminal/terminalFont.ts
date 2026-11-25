import { createContext, useContext } from 'react'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

// Terminals that ship with (or are commonly paired with) a Nerd Font in
// their default install / quick-start docs. This is a *heuristic* — users
// can run Alacritty with a Nerd Font configured and we'd miss it; they can
// also run Ghostty with the default font swapped out. The `/config` setting
// and the env-var override below are the escape hatches for both cases.
const NERD_FONT_TERMINALS = new Set([
  'ghostty',
  'kitty',
  'WezTerm',
  'iTerm.app',
  'WarpTerminal',
])

const NERD_FONT_TERM_PATTERNS = ['kitty', 'ghostty', 'wezterm']

// Variables those terminals export into every shell they start. tmux
// overwrites TERM_PROGRAM and TERM, but these survive into a tmux session
// started from the terminal, so they still name what draws the glyphs — but
// only there: they reach any other emulator started from that shell too
// (`code .`, `alacritty &`), which they would wrongly vouch for. iTerm2's
// LC_TERMINAL is the one `ssh` forwards too (LC_*), so tmux over ssh still
// sees it, which is right: the font is the local terminal's either way.
const NERD_FONT_TERMINAL_MARKERS = [
  'GHOSTTY_RESOURCES_DIR',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
]

export const NERD_FONT_ICONS_OPTIONS = ['auto', 'on', 'off'] as const
export type NerdFontIconsSetting = (typeof NERD_FONT_ICONS_OPTIONS)[number]

/** tmux or screen is in front, so TERM_PROGRAM and TERM name it, not the terminal. */
function isMultiplexer(env: NodeJS.ProcessEnv): boolean {
  if (env.TMUX) return true
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? ''
  if (termProgram === 'tmux' || termProgram === 'screen') return true
  const term = env.TERM?.toLowerCase() ?? ''
  return term.startsWith('tmux') || term.startsWith('screen')
}

/**
 * Whether the terminal named by `env` is one that usually renders Nerd Font
 * glyphs: a known TERM_PROGRAM, a known TERM keyword (e.g. `xterm-kitty`), or,
 * under tmux or screen, the variables the outer terminal leaves behind.
 */
export function detectNerdFontTerminal(env: NodeJS.ProcessEnv): boolean {
  const termProgram = env.TERM_PROGRAM
  if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true

  const term = env.TERM?.toLowerCase() ?? ''
  if (NERD_FONT_TERM_PATTERNS.some(p => term.includes(p))) return true

  if (!isMultiplexer(env)) return false
  if (NERD_FONT_TERMINAL_MARKERS.some(name => env[name])) return true
  return env.LC_TERMINAL === 'iTerm2'
}

/**
 * The resolution order, as a pure function:
 *
 *   1. `CLAUDIN_NERD_FONT=on/1/true` → on; `=off/0/false` → off
 *   2. `/config` → "Nerd Font icons" set to on / off
 *   3. `auto` (or unset) → the terminal heuristic
 *
 * `terminal` is a thunk so the heuristic only runs when nothing above decides.
 */
export function resolveNerdFontGlyphs(
  override: string | undefined,
  setting: NerdFontIconsSetting | undefined,
  terminal: () => boolean,
): boolean {
  if (isEnvTruthy(override)) return true
  if (isEnvDefinedFalsy(override)) return false
  if (setting === 'on') return true
  if (setting === 'off') return false
  return terminal()
}

// The terminal cannot change under a running process, so the heuristic is
// resolved once. The override and the setting are read on every call:
// `/config` applies without a restart.
let terminalDetection: boolean | undefined

function terminalHasNerdFont(): boolean {
  terminalDetection ??= detectNerdFontTerminal(process.env)
  return terminalDetection
}

export function resetNerdFontDetectionForTesting(): void {
  terminalDetection = undefined
}

/** True when `CLAUDIN_NERD_FONT` pins the answer, so `/config` can say so. */
export function isNerdFontForcedByEnv(): boolean {
  const override = process.env.CLAUDIN_NERD_FONT
  return isEnvTruthy(override) || isEnvDefinedFalsy(override)
}

/**
 * Returns true when the active terminal is likely to render Nerd Font /
 * Powerline glyphs (U+E0A0–U+E0D7, the nf-md range, etc.). The conservative
 * default (off when unknown) means callers get safe ASCII fallback in
 * unfamiliar terminals.
 */
export function hasNerdFontGlyphs(): boolean {
  return resolveNerdFontGlyphs(
    process.env.CLAUDIN_NERD_FONT,
    getGlobalConfig().nerdFontIcons,
    terminalHasNerdFont,
  )
}

/**
 * A render whose text leaves the terminal (/export, the ctrl+e transcript)
 * sets this to false: whatever opens the file has no reason to have the font.
 * Unset, components follow hasNerdFontGlyphs().
 */
export const NerdFontGlyphsContext = createContext<boolean | undefined>(undefined)

/** hasNerdFontGlyphs() for a component, unless a NerdFontGlyphsContext says otherwise. */
export function useNerdFontGlyphs(): boolean {
  return useContext(NerdFontGlyphsContext) ?? hasNerdFontGlyphs()
}
