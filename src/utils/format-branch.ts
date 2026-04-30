import chalk from 'chalk'

const BG_CWD = '#1a3050' // dark navy for path segment
const BG_BRANCH = '#264f78' // medium blue for branch segment
const SEP = '\uE0B0' // Powerline right-arrow filled (requires Nerd Font)
const BRANCH_ICON = '\uE0A0' // Powerline branch glyph

/**
 * Builds a Powerline-style ANSI string for use as borderText content.
 * Two segments: path (dark bg) → branch + ahead/behind (medium blue bg),
 * separated and capped with Powerline triangle glyphs.
 */
export function buildBranchBorderSegment(
  displayCwd: string,
  branch: string,
  ahead: number,
  behind: number,
): string {
  let seg = chalk.bgHex(BG_CWD).bold.white(` ${displayCwd} `)

  if (branch) {
    seg += chalk.hex(BG_CWD).bgHex(BG_BRANCH)(SEP)
    seg += chalk.bgHex(BG_BRANCH).white(` ${BRANCH_ICON} ${branch}`)
    if (ahead > 0 || behind > 0) {
      seg += chalk.bgHex(BG_BRANCH).white(' (')
      if (ahead > 0) seg += chalk.bgHex(BG_BRANCH).green(`↑${ahead}`)
      if (ahead > 0 && behind > 0) seg += chalk.bgHex(BG_BRANCH).white(' ')
      if (behind > 0) seg += chalk.bgHex(BG_BRANCH).yellow(`↓${behind}`)
      seg += chalk.bgHex(BG_BRANCH).white(')')
    }
    seg += chalk.bgHex(BG_BRANCH).white(' ')
    seg += chalk.hex(BG_BRANCH)(SEP)
  } else {
    seg += chalk.hex(BG_CWD)(SEP)
  }

  return seg
}
