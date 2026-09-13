import type { Command } from 'src/commands/commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description:
    'Review local changes, stashes and git log in a tabbed, split-pane viewer',
  // The transcript behind the reviewer is unreadable and unscrollable anyway —
  // take the whole screen so the diff gets every row and column.
  fullscreenPanel: true,
  load: () => import('src/commands/diff/diff.js'),
} satisfies Command
