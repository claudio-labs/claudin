import chalk, { type ChalkInstance } from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { OSC8_START, OSC8_END } from './hyperlink.js'
import { hasNerdFontGlyphs } from './terminalFont.js'
import type { Theme } from './theme.js'

const SEP = '\uE0B0'         // Powerline right-arrow filled — closes path segment as cap
const BRANCH_ICON = '\uE725' // Nerd Font devicon git-branch (pairs with PR_ICON)
const PR_ICON = ''     // Nerd Font octicon git-pull-request
const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

export function resolveBranchBg(theme: Theme): string {
  const raw = theme.messageActionsBackground
  // In light-ansi, messageActionsBackground = 'ansi:white' which equals the
  // terminal default — the segment bg + cap arrows would be invisible.
  // Fall back to theme.inactive (a contrasting gray) for that case.
  return raw === 'ansi:white' || raw === 'ansi:whiteBright' ? theme.inactive : raw
}

/**
 * Background for the PR/MR pill: the theme's neutral-gray panel color, so the
 * pill reads as gray and stands apart from the (slightly blue) branch pill.
 * Same ansi:white guard as resolveBranchBg.
 */
export function resolvePrBg(theme: Theme): string {
  const raw = theme.userMessageBackground
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
export function buildCwdPill(displayCwd: string, theme: Theme, nextBg?: string): string {
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg').bold
    return `[ ${fg(displayCwd)} ]`
  }
  const cwdBg = theme.suggestion
  const cwdFg = theme.inverseText
  const cwdChalk = applyColor(applyColor(chalk, cwdBg, 'bg'), cwdFg, 'fg').bold
  // Trailing arrow: when another pill follows, paint it over the next pill's
  // background so the two segments join seamlessly (no terminal-bg gap);
  // otherwise render the arrow over the default terminal bg.
  const capChalk = nextBg
    ? applyColor(applyColor(chalk, nextBg, 'bg'), cwdBg, 'fg')
    : applyColor(chalk, cwdBg, 'fg')
  // Square (flat) left edge — start the colored block directly; pointed
  // (arrow) right edge.
  return cwdChalk(` ${displayCwd} `) + capChalk(SEP)
}

/**
 * Provider pill — vibrant palette (suggestion blue bg, dark bold text) so it
 * stands out as the leading segment of the row.
 */
export function buildProviderPill(label: string, theme: Theme, nextBg?: string): string {
  if (!label) return ''
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg').bold
    return `[ ${fg(label.trim())} ]`
  }
  const bg = theme.suggestion
  const fg = theme.inverseText
  const text = applyColor(applyColor(chalk, bg, 'bg'), fg, 'fg').bold
  // Trailing arrow: when another pill follows, paint it over the next pill's
  // background so the two segments join seamlessly (no terminal-bg gap);
  // otherwise render the arrow over the default terminal bg.
  const cap = nextBg
    ? applyColor(applyColor(chalk, nextBg, 'bg'), bg, 'fg')
    : applyColor(chalk, bg, 'fg')
  // Square (flat) left edge — start the colored block directly with a padding
  // space instead of the rounded left cap; pointed (arrow) right edge.
  return text(` ${label}`) + cap(SEP)
}

/**
 * Model pill — muted branch-style palette (azul cinza) so it reads as the
 * secondary segment next to the vibrant provider pill.
 */
export function buildModelPill(label: string, theme: Theme, nextBg?: string): string {
  if (!label) return ''
  if (!hasNerdFontGlyphs()) {
    const fg = applyColor(chalk, theme.suggestion, 'fg')
    return `[ ${fg(label.trim())} ]`
  }
  const bg = resolveBranchBg(theme)
  const fg = theme.suggestion
  const text = applyColor(applyColor(chalk, bg, 'bg'), fg, 'fg')
  // Trailing arrow: when another pill follows, paint it over the next pill's
  // background so the two segments join seamlessly (no terminal-bg gap);
  // otherwise render the arrow over the default terminal bg.
  const cap = nextBg
    ? applyColor(applyColor(chalk, nextBg, 'bg'), bg, 'fg')
    : applyColor(chalk, bg, 'fg')
  // Square (flat) left edge + pointed (arrow) right edge, matching the provider pill.
  return text(` ${label}`) + cap(SEP)
}

/**
 * Effort pill — standalone Powerline segment for the model-thinking indicator
 * (e.g. `● high`). The `bg` is a resolved theme color string chosen per effort
 * level by the caller (traffic-light: gray/amber/red/blue), so the level pops at
 * a glance. Bold inverseText for legibility on the colored block.
 */
export function buildEffortPill(label: string, bg: string, theme: Theme): string {
  if (!label) return ''
  if (!hasNerdFontGlyphs()) {
    return `[ ${label} ]`
  }
  const text = applyColor(applyColor(chalk, bg, 'bg'), theme.inverseText, 'fg').bold
  const cap = applyColor(chalk, bg, 'fg')
  // Square (flat) left edge + pointed (arrow) right edge, matching the other pills.
  return text(` ${label} `) + cap(SEP)
}

export interface DiffStatSegment {
  /** ANSI-styled segment, ready to drop into a rule. */
  text: string
  /** Rendered cell width of `text` — callers size the rule fill with this. */
  width: number
}

export interface DiffCount {
  added: number
  removed: number
}

export interface DiffStatInput {
  /** This session's write-tool churn. Leads the segment and carries the bar. */
  session: DiffCount
  /** Working tree vs HEAD, labelled `HEAD`. */
  uncommitted?: DiffCount | null
  /** Branch vs its base, labelled with that base's name (e.g. `main`). */
  branch?: (DiffCount & { base: string }) | null
}

/** Cells in the GitHub-style add/remove proportion bar. */
const DIFF_BAR_CELLS = 4
// U+25A0 rather than a full block: the block fills its whole cell, so four of
// them fuse into one chunky rectangle. The small square leaves the cell's own
// padding around it, which reads as four separate cells.
const BAR_CELL = '■'

/**
 * GitHub-style proportion bar: the added share in green, the rest in red, over
 * a fixed four cells. Deliberately not forcing a minimum cell per side — that
 * would draw a 157/6 split as a quarter deletions; the `-6` next to the bar is
 * what carries a small side. Nerd-Font-gated like the Powerline pills, so
 * plain terminals get the numbers only.
 */
function buildDiffBar(
  added: number,
  removed: number,
  addedChalk: ChalkInstance,
  removedChalk: ChalkInstance,
): string {
  if (!hasNerdFontGlyphs()) return ''
  const total = added + removed
  if (total <= 0) return ''
  const green = Math.round((added / total) * DIFF_BAR_CELLS)
  return addedChalk(BAR_CELL.repeat(green)) + removedChalk(BAR_CELL.repeat(DIFF_BAR_CELLS - green))
}

/**
 * Diff-stat segment for the prompt's top rule, up to three groups wide:
 *
 *   `[ +254 -30 ■■■■  HEAD +12 -3  main +1240 -300 ]`
 *
 * The lead group is the session's own churn (the only one available outside a
 * git repo); the labelled ones name the ref they are measured against, which
 * is cheaper to read than an icon and cannot render as tofu.
 *
 * Bracketed rather than Powerline-capped because it shares that rule with the
 * `[ bash mode ]` label and has to read as the same kind of thing.
 *
 * `maxWidth` trims from the right — the git groups go before the session one —
 * and returns null once even the lead group would not fit, so a narrow
 * terminal keeps a plain border rather than a wrapped rule. Also null when
 * nothing has been edited yet.
 */
export function buildDiffStatSegment(
  input: DiffStatInput,
  theme: Theme,
  maxWidth = Number.POSITIVE_INFINITY,
): DiffStatSegment | null {
  const addedChalk = applyColor(chalk, theme.success, 'fg')
  const removedChalk = applyColor(chalk, theme.error, 'fg')
  const mutedChalk = applyColor(chalk, theme.inactive, 'fg')

  const counts = (count: DiffCount, ref?: string): { text: string; width: number } | null => {
    if (count.added <= 0 && count.removed <= 0) return null
    const parts: string[] = []
    let width = 0
    if (ref) {
      parts.push(mutedChalk(ref))
      width += ref.length
    }
    if (count.added > 0) {
      const label = `+${count.added}`
      parts.push(addedChalk(label))
      width += label.length
    }
    if (count.removed > 0) {
      const label = `-${count.removed}`
      parts.push(removedChalk(label))
      width += label.length
    }
    return { text: parts.join(' '), width: width + parts.length - 1 }
  }

  const groups: Array<{ text: string; width: number }> = []
  const session = counts(input.session)
  if (session) {
    const bar = buildDiffBar(input.session.added, input.session.removed, addedChalk, removedChalk)
    groups.push(
      bar
        ? { text: `${session.text} ${bar}`, width: session.width + 1 + DIFF_BAR_CELLS }
        : session,
    )
  }
  const uncommitted = input.uncommitted ? counts(input.uncommitted, 'HEAD') : null
  if (uncommitted) groups.push(uncommitted)
  const branch = input.branch ? counts(input.branch, input.branch.base) : null
  if (branch) groups.push(branch)
  if (groups.length === 0) return null

  // `[` + space + groups (double-space joins) + space + `]`
  const measure = (n: number): number =>
    groups.slice(0, n).reduce((sum, g) => sum + g.width, 0) + (n - 1) * 2 + 4
  let shown = groups.length
  while (shown > 1 && measure(shown) > maxWidth) shown--
  if (measure(shown) > maxWidth) return null

  const body = groups
    .slice(0, shown)
    .map(g => g.text)
    .join('  ')
  return { text: `${mutedChalk('[')} ${body} ${mutedChalk(']')}`, width: measure(shown) }
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
  nextBg?: string,
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
  // Trailing arrow: when another pill follows, paint it over the next pill's
  // background so the two segments join seamlessly (no terminal-bg gap);
  // otherwise render the arrow over the default terminal bg.
  const capChalk = nextBg
    ? applyColor(applyColor(chalk, nextBg, 'bg'), branchBg, 'fg')
    : applyColor(chalk, branchBg, 'fg')

  // Square (flat) left edge — start the colored block directly; pointed
  // (arrow) right edge.
  let seg = branchChalk(` ${BRANCH_ICON} ${branch}`)
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
 * Wrap already-styled text in an OSC 8 hyperlink so clicking it opens `url`,
 * when the terminal supports it. Done manually (not via createHyperlink) to
 * keep the caller's existing color instead of forcing blue.
 */
function linkify(text: string, url: string | undefined): string {
  if (!url || !supportsHyperlinks()) return text
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`
}

/**
 * Standalone PR/MR Powerline pill: `[◄ PR #n ►]`. Shares the branch pill's
 * background for visual cohesion; the `#n` is coloured by review state. The
 * `labelText` varies by host ("PR" for GitHub/Gitea, "MR" for GitLab). When a
 * `url` is given, the `#n` becomes a clickable OSC 8 hyperlink.
 */
export function buildPrPill(
  prNumber: number,
  state: PrPillState,
  theme: Theme,
  labelText: 'PR' | 'MR' = 'PR',
  url?: string,
): string {
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
    const num = linkify(applyColor(chalk, numberFg, 'fg')(`#${prNumber}`), url)
    const label = applyColor(chalk, theme.inactive, 'fg')(labelText)
    return `[ ${label} ${num} ]`
  }
  const prBg = resolvePrBg(theme)
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
  const labelChalk = applyColor(applyColor(chalk, prBg, 'bg'), theme.inactive, 'fg')
  const numChalk = applyColor(applyColor(chalk, prBg, 'bg'), numberFg, 'fg')
  const capChalk = applyColor(chalk, prBg, 'fg')

  // Square (flat) left edge — start the colored block directly; pointed
  // (arrow) right edge.
  return (
    labelChalk(` ${PR_ICON} `) +
    linkify(numChalk(`#${prNumber}`), url) +
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
