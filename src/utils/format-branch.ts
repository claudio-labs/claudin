import chalk, { type ChalkInstance } from 'chalk'
import { hasNerdFontGlyphs } from './terminalFont.js'
import type { Theme } from './theme.js'

const SEP = '\uE0B0'         // Powerline right-arrow filled — closes path segment as cap
const BRANCH_ICON = '\uE0A0' // Powerline branch glyph
const SEP_LEFT = ''    // Powerline left-arrow filled — opens pill from default bg
const PR_ICON = ''     // Nerd Font octicon git-pull-request
const CAP_LEFT_ROUND = '\uE0B6'  // Powerline rounded left cap
const CAP_RIGHT_ROUND = '\uE0B4' // Powerline rounded right cap
const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

function resolveBranchBg(theme: Theme): string {
  const raw = theme.messageActionsBackground
  // In light-ansi, messageActionsBackground = 'ansi:white' which equals the
  // terminal default — the segment bg + cap arrows would be invisible.
  // Fall back to theme.inactive (a contrasting gray) for that case.
  return raw === 'ansi:white' || raw === 'ansi:whiteBright' ? theme.inactive : raw
}

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
 *   [suggestion bg, bold inverseText: ~/path ][►][faint bg, inactive: ⎇ branch (↑N) ][►]
 *
 * Path: vibrant suggestion bg with dark bold text.
 * Branch: very faint messageActionsBackground with muted inactive text.
 * Colors are resolved from the active Claudin theme.
 */
export function buildBranchBorderSegment(
  displayCwd: string,
  branch: string,
  ahead: number,
  behind: number,
  theme: Theme,
): string {
  if (!hasNerdFontGlyphs()) {
    return buildPlainBranchBorderSegment(displayCwd, branch, ahead, behind, theme)
  }
  const cwdBg = theme.suggestion              // vibrant bg for path
  // In light-ansi, messageActionsBackground = 'ansi:white' which equals the
  // terminal default — the entire branch segment (bg + cap arrow) would be
  // invisible. Fall back to theme.inactive (a contrasting gray) for that case.
  const rawBranchBg = theme.messageActionsBackground
  const branchBg =
    rawBranchBg === 'ansi:white' || rawBranchBg === 'ansi:whiteBright'
      ? theme.inactive
      : rawBranchBg
  const cwdFg = theme.inverseText             // dark bold text on path
  const branchFg = theme.suggestion           // theme blue on branch (same as path bg — cohesive)

  const cwdChalk = applyColor(applyColor(chalk, cwdBg, 'bg'), cwdFg, 'fg').bold
  const sepChalk = applyColor(applyColor(chalk, cwdBg, 'fg'), branchBg, 'bg')
  const branchChalk = applyColor(applyColor(chalk, branchBg, 'bg'), branchFg, 'fg')
  const endChalk = applyColor(chalk, branchBg, 'fg')
  const cwdEndChalk = applyColor(chalk, cwdBg, 'fg')

  let seg = cwdChalk(` ${displayCwd} `)

  if (branch) {
    seg += sepChalk(SEP)
    seg += branchChalk(` ${BRANCH_ICON} ${branch}`)
    if (ahead > 0 || behind > 0) {
      seg += branchChalk(' (')
      if (ahead > 0) seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.success, 'fg')(`↑${ahead}`)
      if (ahead > 0 && behind > 0) seg += branchChalk(' ')
      if (behind > 0) seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.warning, 'fg')(`↓${behind}`)
      seg += branchChalk(')')
    }
    seg += branchChalk(' ')
    seg += endChalk(SEP)
  } else {
    seg += cwdEndChalk(SEP)
  }

  return seg
}

/**
 * Standalone cwd Powerline pill: `[◄ ~/path ►]`. Same colours as the cwd half
 * of `buildBranchBorderSegment`; caps on both sides so it can sit anywhere on
 * a border (start, end, or adjacent to other pills).
 */
export function buildCwdPill(displayCwd: string, theme: Theme): string {
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg').bold
    return `[ ${fg(displayCwd)} ]`
  }
  const cwdBg = theme.suggestion
  const cwdFg = theme.inverseText
  const cwdChalk = applyColor(applyColor(chalk, cwdBg, 'bg'), cwdFg, 'fg').bold
  const capChalk = applyColor(chalk, cwdBg, 'fg')
  return capChalk(SEP_LEFT) + cwdChalk(` ${displayCwd} `) + capChalk(SEP)
}

/**
 * Provider pill — branch-style palette (azul cinza / muted) so it pairs
 * visually with the branch pill on the opposite side of the row.
 */
export function buildProviderPill(label: string, theme: Theme): string {
  if (!label) return ''
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg')
    return `[ ${fg(label.trim())} ]`
  }
  const bg = resolveBranchBg(theme)
  const fg = theme.suggestion
  const text = applyColor(applyColor(chalk, bg, 'bg'), fg, 'fg')
  const cap = applyColor(chalk, bg, 'fg')
  return cap(CAP_LEFT_ROUND) + text(`${label}`) + cap(CAP_RIGHT_ROUND)
}

/**
 * Model pill — cwd-style palette (vibrant blue) so it mirrors the cwd pill
 * on the opposite side of the row. Rounded Powerline caps.
 */
export function buildModelPill(label: string, theme: Theme): string {
  if (!label) return ''
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg').bold
    return `[ ${fg(label.trim())} ]`
  }
  const bg = theme.suggestion
  const fg = theme.inverseText
  const text = applyColor(applyColor(chalk, bg, 'bg'), fg, 'fg').bold
  const cap = applyColor(chalk, bg, 'fg')
  return cap(CAP_LEFT_ROUND) + text(`${label}`) + cap(CAP_RIGHT_ROUND)
}

/**
 * Standalone branch Powerline pill: `[◄ ⎇ branch (↑N ↓M) ►]`. Caps on both
 * sides so it can be placed independently of the cwd pill (e.g. on the
 * top-right border of the prompt input).
 */
export function buildBranchPill(
  branch: string,
  ahead: number,
  behind: number,
  theme: Theme,
): string {
  if (!branch) return ''
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg')
    let inner = fg(branch)
    if (ahead > 0 || behind > 0) {
      inner += ' ('
      if (ahead > 0) inner += applyColor(chalk, theme.success, 'fg')(`↑${ahead}`)
      if (ahead > 0 && behind > 0) inner += ' '
      if (behind > 0) inner += applyColor(chalk, theme.warning, 'fg')(`↓${behind}`)
      inner += ')'
    }
    return `[ ${inner} ]`
  }
  const branchBg = resolveBranchBg(theme)
  const branchFg = theme.suggestion
  const branchChalk = applyColor(applyColor(chalk, branchBg, 'bg'), branchFg, 'fg')
  const capChalk = applyColor(chalk, branchBg, 'fg')

  let seg = capChalk(SEP_LEFT)
  seg += branchChalk(` ${BRANCH_ICON} ${branch}`)
  if (ahead > 0 || behind > 0) {
    seg += branchChalk(' (')
    if (ahead > 0)
      seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.success, 'fg')(`↑${ahead}`)
    if (ahead > 0 && behind > 0) seg += branchChalk(' ')
    if (behind > 0)
      seg += applyColor(applyColor(chalk, branchBg, 'bg'), theme.warning, 'fg')(`↓${behind}`)
    seg += branchChalk(')')
  }
  seg += branchChalk(' ')
  seg += capChalk(SEP)
  return seg
}

export type PrPillState =
  | 'approved'
  | 'changes_requested'
  | 'pending'
  | 'merged'
  | 'draft'
  | 'closed'
  | null
  | undefined

/**
 * Standalone PR Powerline pill: `[◄ PR #n ►]`. Shares the branch pill's
 * background for visual cohesion; the `#n` is coloured by review state.
 */
export function buildPrPill(prNumber: number, state: PrPillState, theme: Theme): string {
  if (!hasNerdFontGlyphs()) {
    const numberFg =
      state === 'approved'
        ? theme.success
        : state === 'changes_requested'
          ? theme.error
          : state === 'pending'
            ? theme.warning
            : state === 'merged'
              ? theme.merged
              : theme.inactive
    const num = applyColor(chalk, numberFg, 'fg')(`#${prNumber}`)
    const label = applyColor(chalk, theme.inactive, 'fg')('PR')
    return `[ ${label} ${num} ]`
  }
  const branchBg = resolveBranchBg(theme)
  const numberFg =
    state === 'approved'
      ? theme.success
      : state === 'changes_requested'
        ? theme.error
        : state === 'pending'
          ? theme.warning
          : state === 'merged'
            ? theme.merged
            : theme.inactive
  const labelChalk = applyColor(applyColor(chalk, branchBg, 'bg'), theme.inactive, 'fg')
  const numChalk = applyColor(applyColor(chalk, branchBg, 'bg'), numberFg, 'fg')
  const capChalk = applyColor(chalk, branchBg, 'fg')

  return (
    capChalk(SEP_LEFT) +
    labelChalk(` ${PR_ICON} `) +
    numChalk(`#${prNumber}`) +
    labelChalk(' ') +
    capChalk(SEP)
  )
}

/**
 * Nerd-Font-free fallback for `buildBranchBorderSegment`. Produces
 * `[ ~/path ]  [ branch (↑N ↓M) ]` with the same colour palette but no
 * Powerline caps, branch glyph, or pill background.
 */
function buildPlainBranchBorderSegment(
  displayCwd: string,
  branch: string,
  ahead: number,
  behind: number,
  theme: Theme,
): string {
  const cwdFg = applyColor(chalk, theme.suggestion, 'fg').bold
  let seg = `[ ${cwdFg(displayCwd)} ]`
  if (branch) {
    const branchFg = applyColor(chalk, theme.suggestion, 'fg')
    let inner = branchFg(branch)
    if (ahead > 0 || behind > 0) {
      inner += ' ('
      if (ahead > 0) inner += applyColor(chalk, theme.success, 'fg')(`↑${ahead}`)
      if (ahead > 0 && behind > 0) inner += ' '
      if (behind > 0) inner += applyColor(chalk, theme.warning, 'fg')(`↓${behind}`)
      inner += ')'
    }
    seg += `  [ ${inner} ]`
  }
  return seg
}
