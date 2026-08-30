// Glyph set for the collapsed footer summary line (FooterTaskSummary), one
// entry per task group. Mirrors getDiffGlyphs() in src/vcs/diff/ui/glyphs.ts:
// every Nerd Font codepoint lives here, and callers go through
// getFooterGroupSegments(), which substitutes the group's word on a terminal
// without a Nerd Font so we never paint tofu.

import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'
import {
  FOOTER_GROUP_LABELS,
  FOOTER_GROUP_ORDER,
  type FooterGroupKey,
} from 'src/agent/ui/tasks/footerTaskGeometry.js'

// All seven are Material Design (nf-md-*, supplementary PUA). The Font Awesome
// range was tried first and every nf-fa-* codepoint painted blank on a
// JetBrainsMono Nerd Font that fontconfig reported as covering it — the
// charset carries the codepoint without a glyph behind it. Prefer nf-md-* when
// adding a group, and check the glyph on a real terminal rather than trusting
// `fc-list :charset=`.
const GROUP_ICONS: Record<FooterGroupKey, string> = {
  agents: '\u{f06a9}', // nf-md-robot
  shells: '\u{f1183}', // nf-md-console_line
  monitors: '\u{f0379}', // nf-md-monitor
  containers: '\u{f0868}', // nf-md-docker
  remote: '\u{f015f}', // nf-md-cloud
  workflows: '\u{f1049}', // nf-md-graph
  dreams: '\u{f04b2}', // nf-md-sleep
}

/**
 * What to print for each group on the collapsed line: the Nerd Font icon, or
 * the group's word when the terminal has no Nerd Font. Never returns an empty
 * string — a segment always carries something, or the count beside it would be
 * unattributable.
 *
 * Reads env (via `hasNerdFontGlyphs`), so callers should memoize the result.
 */
export function getFooterGroupSegments(): Record<FooterGroupKey, string> {
  const enabled = hasNerdFontGlyphs()
  const segments = {} as Record<FooterGroupKey, string>
  for (const key of FOOTER_GROUP_ORDER) {
    segments[key] = enabled ? GROUP_ICONS[key] : FOOTER_GROUP_LABELS[key]
  }
  return segments
}
