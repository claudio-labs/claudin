import chalk, { type ChalkInstance } from 'chalk'
import type { Theme } from './theme.js'

const SEP = '\uE0B0' // Powerline right-arrow filled (requires Nerd Font)
const BRANCH_ICON = '\uE0A0' // Powerline branch glyph
const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

/**
 * Compose a theme Color string (rgb/hex/ansi:/ansi256) onto a chalk instance,
 * returning a new chalk instance. Unlike colorize() in ink/colorize.ts, this
 * returns a ChalkInstance (not a string), so fg and bg can be composed together
 * on the same chalk call — which is required for Powerline separator characters.
 */
function applyColor(c: ChalkInstance, raw: string, type: 'fg' | 'bg'): ChalkInstance {
  if (raw.startsWith('ansi:')) {
    const name = raw.slice(5)
    if (type === 'fg') return (c as Record<string, ChalkInstance>)[name] ?? c
    const bgName = `bg${name[0]!.toUpperCase()}${name.slice(1)}`
    return (c as Record<string, ChalkInstance>)[bgName] ?? c
  }
  if (raw.startsWith('#')) {
    return type === 'fg' ? c.hex(raw) : c.bgHex(raw)
  }
  if (raw.startsWith('ansi256(')) {
    const n = parseInt(raw.slice(8))
    return type === 'fg' ? c.ansi256(n) : c.bgAnsi256(n)
  }
  const rgb = RGB_REGEX.exec(raw)
  if (rgb) {
    const [r, g, b] = [+rgb[1], +rgb[2], +rgb[3]]
    return type === 'fg' ? c.rgb(r, g, b) : c.bgRgb(r, g, b)
  }
  return c
}

/**
 * Builds a Powerline-style ANSI string for use as borderText content.
 * Two segments separated by triangle glyphs (U+E0B0):
 *   [userMessageBackground: ~/path ][►][planMode: ⎇ branch (↑N) ][►]
 *
 * Colors are resolved from the active Claudio theme so the segments match
 * the rest of the UI and respect the user's theme and terminal palette.
 */
export function buildBranchBorderSegment(
  displayCwd: string,
  branch: string,
  ahead: number,
  behind: number,
  theme: Theme,
): string {
  const cwdBg = theme.userMessageBackground
  const branchBg = theme.selectionBg
  const fg = theme.text

  const cwdChalk = applyColor(applyColor(chalk, cwdBg, 'bg'), fg, 'fg').bold
  const branchChalk = applyColor(applyColor(chalk, branchBg, 'bg'), fg, 'fg')
  const sepChalk = applyColor(applyColor(chalk, cwdBg, 'fg'), branchBg, 'bg')
  const endChalk = applyColor(chalk, branchBg, 'fg')
  const cwdEndChalk = applyColor(chalk, cwdBg, 'fg')

  let seg = cwdChalk(` ${displayCwd} `)

  if (branch) {
    seg += sepChalk(SEP)
    seg += branchChalk(` ${BRANCH_ICON} ${branch}`)
    if (ahead > 0 || behind > 0) {
      seg += branchChalk(' (')
      if (ahead > 0) {
        seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.success, 'fg')(`↑${ahead}`)
      }
      if (ahead > 0 && behind > 0) seg += branchChalk(' ')
      if (behind > 0) {
        seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.warning, 'fg')(`↓${behind}`)
      }
      seg += branchChalk(')')
    }
    seg += branchChalk(' ')
    seg += endChalk(SEP)
  } else {
    seg += cwdEndChalk(SEP)
  }

  return seg
}
