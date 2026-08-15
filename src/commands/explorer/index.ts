import type { Command } from 'src/commands.js'

export default {
  type: 'local-jsx',
  name: 'explorer',
  aliases: ['editor'],
  description: 'Browse the project tree and edit files (nvim-lite, split-pane)',
  load: () => import('src/commands/explorer/explorer.js'),
} satisfies Command
