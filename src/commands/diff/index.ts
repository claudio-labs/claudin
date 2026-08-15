import type { Command } from 'src/commands/commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description:
    'Review local changes, stashes and git log in a tabbed, split-pane viewer',
  load: () => import('src/commands/diff/diff.js'),
} satisfies Command
