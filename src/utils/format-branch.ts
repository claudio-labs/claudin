import chalk, { type ChalkInstance } from 'chalk'
import type { Theme } from './theme.js'

const SEP = '\uE0B0'      // Powerline right-arrow filled (hard separator, fg=left bg, bg=right bg)
const SOFT_SEP = '\uE0B1' // Powerline right-arrow outline (soft separator, same bg both sides)
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
 *
 * Both segments share the same bg (suggestion — lavender-blue in dark theme)
 * so the branch feels light ("clarinho"). They're separated by the soft outline
 * arrow U+E0B1 instead of the filled U+E0B0 (which requires a bg color change).
 *
 *   [suggestion bg, bold inverseText: ~/path ][›][suggestion bg, inactive: ⎇ branch ][►]
 *
 * Colors are resolved from the active Claudio theme.
 */
export function buildBranchBorderSegment(
  displayCwd: string,
  branch: string,
  ahead: number,
  behind: number,
  theme: Theme,
): string {
  const bg = theme.suggestion        // same bg for both segments (light lavender in dark theme)
  const cwdFg = theme.inverseText    // dark bold text on vibrant path segment
  const branchFg = theme.inactive    // muted/dim text on branch segment (matches image style)

  const cwdChalk = applyColor(applyColor(chalk, bg, 'bg'), cwdFg, 'fg').bold
  const branchChalk = applyColor(applyColor(chalk, bg, 'bg'), branchFg, 'fg')
  // Soft separator: same bg, branch-text color fg — a subtle outline arrow between segments
  const softSepChalk = applyColor(applyColor(chalk, bg, 'bg'), branchFg, 'fg')
  // End cap: filled arrow, segment bg as fg against terminal default
  const endChalk = applyColor(chalk, bg, 'fg')

  let seg = cwdChalk(` ${displayCwd} `)

  if (branch) {
    seg += softSepChalk(SOFT_SEP)
    seg += branchChalk(` ${BRANCH_ICON} ${branch}`)
    if (ahead > 0 || behind > 0) {
      seg += branchChalk(' (')
      if (ahead > 0) {
        seg += applyColor(applyColor(chalk, bg, 'bg'), theme.success, 'fg')(`↑${ahead}`)
      }
      if (ahead > 0 && behind > 0) seg += branchChalk(' ')
      if (behind > 0) {
        seg += applyColor(applyColor(chalk, bg, 'bg'), theme.warning, 'fg')(`↓${behind}`)
      }
      seg += branchChalk(')')
    }
    seg += branchChalk(' ')
    seg += endChalk(SEP)
  } else {
    seg += endChalk(SEP)
  }

  return seg
}
