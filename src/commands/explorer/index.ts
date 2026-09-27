import type { Command } from 'src/commands/commands.js'

export default {
  type: 'local-jsx',
  name: 'explorer',
  aliases: ['editor'],
  description: 'Browse the project tree and edit files (nvim-lite, split-pane)',
  // The split tree | editor needs the fullscreen layout: inline sessions
  // visit the alt screen while it is open.
  fullscreenLayout: true,
  load: () => import('src/commands/explorer/explorer.js'),
} satisfies Command
