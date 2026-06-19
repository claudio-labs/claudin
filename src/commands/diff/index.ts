import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description:
    'Review local changes, stashes and git log in a tabbed, split-pane viewer',
  load: () => import('./diff.js'),
} satisfies Command
