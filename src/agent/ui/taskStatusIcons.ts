// Status icon for a task row and the totals line in TaskListV2. Mirrors
// getFooterGroupSegments() in tasks/footerGroupIcons.ts: the Nerd Font set is
// used only when hasNerdFontGlyphs() says the terminal draws it, so every
// other terminal keeps the figures glyphs it always had.

import figures from 'figures'
import type { Task } from 'src/agent/tasks/tasks.js'
import type { Theme } from 'src/terminal/theme/theme.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'

// nf-md-* (footerGroupIcons.ts has why not nf-fa-*). One circle family, so
// the three states read as one set.
const NERD_ICONS: Record<Task['status'], string> = {
  completed: '\u{f0134}', // nf-md-checkbox_marked_circle_outline
  in_progress: '\u{f0996}', // nf-md-progress_clock
  pending: '\u{f0130}', // nf-md-checkbox_blank_circle_outline
}

const FALLBACK_ICONS: Record<Task['status'], string> = {
  completed: figures.tick,
  in_progress: figures.squareSmallFilled,
  pending: figures.squareSmall,
}

const COLORS: Record<Task['status'], keyof Theme | undefined> = {
  completed: 'success',
  in_progress: 'claude',
  pending: undefined,
}

export function getTaskIcon(status: Task['status']): {
  icon: string
  color: keyof Theme | undefined
} {
  const icons = hasNerdFontGlyphs() ? NERD_ICONS : FALLBACK_ICONS
  return { icon: icons[status], color: COLORS[status] }
}
